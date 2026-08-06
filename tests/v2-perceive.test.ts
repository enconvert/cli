// Request-shape goldens + output invariants for `enconvert perceive` (sync,
// get, batch) against the mock gateway. Contract: .spec/api-contract.md §8.1-8.5.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  runCli,
  scratchDir,
  startMockGateway,
  TEST_KEY,
  type MockGateway,
} from "./helpers/harness.js";

const URL_A = "https://example.com";

function completedPerceive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: "per_ab12cd34",
    status: "completed",
    url: URL_A,
    cache_hit: false,
    outputs: {},
    warnings: [],
    ...overrides,
  };
}

function envFor(gw: MockGateway): Record<string, string> {
  return { ENCONVERT_API_URL: gw.url };
}

test("test_bare_perceive_sends_only_url", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const response = completedPerceive();
  gw.json("POST /v2/perceive", 200, response);

  const res = await runCli(["perceive", URL_A, "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  const req = gw.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v2/perceive");
  assert.equal(req.headers["x-api-key"], TEST_KEY);
  // Golden: ONLY the url — server defaults stay in charge.
  assert.deepEqual(req.json, { url: URL_A });
  assert.deepEqual(JSON.parse(res.stdout), response);
});

test("test_full_flags_golden_body_contains_exactly_the_user_set_fields", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive", 200, completedPerceive());

  const home = scratchDir();
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const schemaPath = join(home, "s.json");
  writeFileSync(schemaPath, JSON.stringify(schema));

  const res = await runCli(
    [
      "perceive", URL_A,
      "--output", "markdown,links",
      "--extract", "tables,metadata",
      "--schema-file", schemaPath,
      "--wait-for", "#main",
      "--wait-timeout-ms", "5000",
      "--js-code", "x",
      "--viewport", "1440x900",
      "--mobile",
      "--respect-robots",
      "--full-page",
      "--cache-mode", "bypass",
      "--block-resource", "image,font",
      "--header", "X-A: 1",
      "--cookie", "a=b;domain=x.com",
      "--basic-auth", "u:p",
      "--json",
    ],
    { env: envFor(gw), home },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  // deepEqual proves every field is correct AND nothing else is present.
  assert.deepEqual(gw.requests[0]!.json, {
    url: URL_A,
    outputs: ["markdown", "links"],
    extract: ["tables", "metadata"],
    schema,
    wait_for: "#main",
    wait_timeout_ms: 5000,
    js_code: "x",
    viewport: { width: 1440, height: 900 },
    mobile: true,
    respect_robots: true,
    only_main_content: false,
    cache_mode: "bypass",
    block_resources: ["image", "font"],
    headers: { "X-A": "1" },
    cookies: [{ name: "a", value: "b", domain: "x.com" }],
    auth: { username: "u", password: "p" },
  });
});

test("test_invalid_output_value_exits_2_without_any_request", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive", 200, completedPerceive());

  const res = await runCli(["perceive", URL_A, "--output", "bogus"], { env: envFor(gw) });

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0, "usage validation must happen offline");
  assert.match(res.stderr, /invalid --output value "bogus"/);
});

test("test_schema_file_with_bad_json_exits_2_without_any_request", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive", 200, completedPerceive());
  const home = scratchDir();
  const badPath = join(home, "bad.json");
  writeFileSync(badPath, "{not json");

  const res = await runCli(["perceive", URL_A, "--schema-file", badPath], {
    env: envFor(gw),
    home,
  });

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0);
  assert.match(res.stderr, /is not valid JSON/);
});

test("test_completed_response_prints_artifact_urls_on_stdout", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json(
    "POST /v2/perceive", 200,
    completedPerceive({
      outputs: {
        markdown: { url: "https://cdn.example/m.md", size_bytes: 10 },
        links: { url: "https://cdn.example/l.json", size_bytes: 5 },
      },
    }),
  );

  const res = await runCli(["perceive", URL_A], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, "https://cdn.example/m.md\nhttps://cdn.example/l.json\n");
  assert.match(res.stderr, /perceive per_ab12cd34: completed/);
});

test("test_output_dir_downloads_artifacts_with_sensible_extensions", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const mdBytes = "# downloaded markdown\n";
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  gw.route("GET /art/md", (_req, res) => {
    res.writeHead(200, { "content-type": "text/markdown" });
    res.end(mdBytes);
  });
  gw.route("GET /art/shot", (_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(pngBytes);
  });
  gw.json(
    "POST /v2/perceive", 200,
    completedPerceive({
      url: "https://example.com/docs",
      outputs: {
        markdown: { url: `${gw.url}/art/md` },
        screenshot: { url: `${gw.url}/art/shot` },
      },
    }),
  );

  const home = scratchDir();
  const outDir = join(home, "out");
  const res = await runCli(["perceive", "https://example.com/docs", "-O", outDir], {
    env: envFor(gw),
    home,
  });

  assert.equal(res.code, 0, res.stderr);
  const mdPath = join(outDir, "example.com-docs.markdown.md");
  const pngPath = join(outDir, "example.com-docs.screenshot.png");
  assert.equal(readFileSync(mdPath, "utf8"), mdBytes);
  assert.deepEqual(readFileSync(pngPath), pngBytes);
  // One absolute path per line on stdout.
  assert.deepEqual(res.stdout.trimEnd().split("\n").sort(), [mdPath, pngPath].sort());
});

test("test_direct_download_streams_artifact_bytes_to_stdout", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const mdBytes = "# direct markdown\n";
  gw.route("POST /v2/perceive", (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/markdown",
      "x-operation-id": "per_direct",
      "x-warnings-count": "0",
    });
    res.end(mdBytes);
  });

  const res = await runCli(
    ["perceive", URL_A, "--direct-download", "--output", "markdown", "-o", "-"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, mdBytes, "-o - must emit the artifact bytes verbatim, nothing else");
  assert.deepEqual(gw.requests[0]!.json, {
    url: URL_A,
    outputs: ["markdown"],
    direct_download: true,
  });
});

test("test_direct_download_json_artifact_bytes_pass_through_verbatim", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  // Deliberately odd formatting: a parse/re-stringify round-trip would destroy it.
  const linkBytes = '{"links": [\n    "https://a.com"\n]}';
  gw.route("POST /v2/perceive", (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(linkBytes);
  });

  const res = await runCli(
    ["perceive", URL_A, "--direct-download", "--output", "links", "-o", "-"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, linkBytes, "JSON artifacts must stream byte-for-byte, not re-encoded");
});

test("test_direct_download_without_single_output_exits_2_without_any_request", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive", 200, completedPerceive());

  const res = await runCli(["perceive", URL_A, "--direct-download"], { env: envFor(gw) });

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0, "usage validation must happen offline");
  assert.match(res.stderr, /--direct-download needs exactly one --output artifact/);
});

test("test_direct_download_writes_output_file_and_prints_path", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const pdfBytes = "%PDF-1.4 direct-download-payload";
  gw.route("POST /v2/perceive", (_req, res) => {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(pdfBytes);
  });

  const home = scratchDir();
  const dest = join(home, "page.pdf");
  const res = await runCli(
    ["perceive", URL_A, "--direct-download", "--output", "pdf", "-o", dest],
    { env: envFor(gw), home },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `${dest}\n`);
  assert.equal(readFileSync(dest, "utf8"), pdfBytes);
});

test("test_perceive_get_hits_get_operation_path", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const response = completedPerceive({ operation_id: "per_x" });
  gw.json("GET /v2/perceive/per_x", 200, response);

  const res = await runCli(["perceive", "get", "per_x", "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.method, "GET");
  assert.equal(gw.requests[0]!.path, "/v2/perceive/per_x");
  assert.deepEqual(JSON.parse(res.stdout), response);
});

function inlineBatchResponse(): Record<string, unknown> {
  return {
    job_id: "batch_1",
    status: "completed",
    output_mode: "manifest",
    total: 2,
    completed: 2,
    failed: 0,
    pending: 0,
    items: [
      {
        operation_id: "per_a",
        status: "completed",
        url: "https://a.com",
        outputs: { markdown: { url: "https://cdn.example/a.md" } },
      },
      {
        operation_id: "per_b",
        status: "completed",
        url: "https://b.com",
        outputs: { markdown: { url: "https://cdn.example/b.md" } },
      },
    ],
    warnings: [],
  };
}

test("test_batch_input_file_skips_comments_and_blank_lines", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive/batch", 200, inlineBatchResponse());

  const home = scratchDir();
  const urlFile = join(home, "urls.txt");
  writeFileSync(urlFile, "# seeds\nhttps://a.com\n\n  # another comment\nhttps://b.com\n");

  const res = await runCli(
    ["perceive", "batch", "--input-file", urlFile, "--output", "markdown", "--output-mode", "manifest"],
    { env: envFor(gw), home },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  const req = gw.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v2/perceive/batch");
  assert.deepEqual(req.json, {
    urls: ["https://a.com", "https://b.com"],
    options: { outputs: ["markdown"] },
    output_mode: "manifest",
  });
});

test("test_batch_200_inline_response_renders_item_urls_on_stdout", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive/batch", 200, inlineBatchResponse());

  const res = await runCli(["perceive", "batch", "https://a.com", "https://b.com"], {
    env: envFor(gw),
  });

  assert.equal(res.code, 0, res.stderr);
  // Bare batch with no flags sends only the urls.
  assert.deepEqual(gw.requests[0]!.json, { urls: ["https://a.com", "https://b.com"] });
  assert.equal(res.stdout, "https://cdn.example/a.md\nhttps://cdn.example/b.md\n");
  assert.match(res.stderr, /batch batch_1: completed \(2\/2 completed, 0 failed\)/);
});

test("test_batch_202_with_wait_polls_get_until_completed", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive/batch", 202, {
    job_id: "batch_9",
    status: "queued",
    total: 2,
    completed: 0,
  });
  let polls = 0;
  gw.route("GET /v2/perceive/batch/batch_9", (_req, res) => {
    polls += 1;
    const payload =
      polls === 1
        ? { job_id: "batch_9", status: "processing", total: 2, completed: 1, failed: 0 }
        : { ...inlineBatchResponse(), job_id: "batch_9" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  const res = await runCli(
    ["perceive", "batch", "https://a.com", "https://b.com", "--wait", "--poll-interval", "1"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.ok(polls >= 2, `expected at least 2 polls, saw ${polls}`);
  const polled = gw.requests.filter(
    (r) => r.method === "GET" && r.path === "/v2/perceive/batch/batch_9",
  );
  assert.ok(polled.length >= 2);
  assert.equal(res.stdout, "https://cdn.example/a.md\nhttps://cdn.example/b.md\n");
});

test("test_batch_202_with_no_wait_prints_job_id", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive/batch", 202, { job_id: "batch_9", status: "queued", total: 2 });

  const res = await runCli(
    ["perceive", "batch", "https://a.com", "https://b.com", "--no-wait"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, "batch_9\n");
  assert.match(res.stderr, /enconvert jobs wait batch_9/);
  // --no-wait must never poll.
  assert.equal(gw.requests.length, 1);
});

test("test_batch_cancel_sends_delete", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("DELETE /v2/perceive/batch/batch_1", 200, {
    job_id: "batch_1",
    status: "canceled",
    total: 2,
    completed: 1,
  });

  const res = await runCli(["perceive", "batch", "cancel", "batch_1"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.method, "DELETE");
  assert.equal(gw.requests[0]!.path, "/v2/perceive/batch/batch_1");
  assert.match(res.stderr, /batch batch_1: canceled \(1\/2 completed before cancel\)/);
});

test("test_scrape_alias_posts_to_v2_perceive", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/perceive", 200, completedPerceive());

  const res = await runCli(["scrape", URL_A, "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.path, "/v2/perceive");
  assert.deepEqual(gw.requests[0]!.json, { url: URL_A });
});
