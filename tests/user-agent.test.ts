// User-Agent contract: every request the CLI makes — JSON API calls, multipart
// uploads, and download fetches — carries `enconvert-cli/<version> (<platform>;
// <arch>)`. The gateway's surface classifier (posthog_client.surface_from_request)
// matches the substrings "mcp" -> mcp, then "enconvert-cli" -> cli, then
// "enconvert-sdk" -> sdk, so the UA must contain "enconvert-cli" and must never
// accidentally contain "mcp" or "enconvert-sdk".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_ROOT, parseMultipart, runCli, scratchDir, startMockGateway } from "./helpers/harness.js";

const PKG_VERSION = (JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as { version: string }).version;
const EXPECTED_UA = `enconvert-cli/${PKG_VERSION} (${process.platform}; ${process.arch})`;

test("test_user_agent_token_classifies_as_cli_surface", () => {
  assert.ok(EXPECTED_UA.startsWith("enconvert-cli/"), "surface token must lead the UA");
  assert.ok(!EXPECTED_UA.includes("mcp"), "an mcp substring would misclassify the surface as mcp");
  assert.ok(!EXPECTED_UA.includes("enconvert-sdk"), "an sdk substring must never appear in the CLI UA");
});

test("test_json_api_request_sends_the_cli_user_agent", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/jobs/job_1", 200, { job_id: "job_1", status: "success" });
    const r = await runCli(["api", "/v1/jobs/job_1"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]!.headers["user-agent"], EXPECTED_UA);
  } finally {
    await gw.close();
  }
});

test("test_multipart_upload_and_presigned_download_send_the_cli_user_agent", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    gw.route("POST /v1/convert/doc-to-pdf", (req, res) => {
      // Sanity-check the recorded body really is the multipart upload.
      parseMultipart(req.body, String(req.headers["content-type"]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          presigned_url: `${gw.url}/presigned/report.pdf`,
          object_key: "prod/files/proj_1/report.pdf",
          filename: "report.pdf",
          file_size: 9,
          conversion_time_seconds: 0.42,
        }),
      );
    });
    gw.route("GET /presigned/report.pdf", (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": "9" });
      res.end("pdf-bytes");
    });

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "-o", join(home, "out.pdf")], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests.length, 2, "expected the upload POST and the download GET");
    for (const req of gw.requests) {
      assert.equal(req.headers["user-agent"], EXPECTED_UA, `${req.method} ${req.path} must carry the CLI UA`);
    }
  } finally {
    await gw.close();
  }
});
