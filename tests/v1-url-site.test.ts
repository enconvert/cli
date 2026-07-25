// Request-shape goldens and async-batch behavior for `url pdf|screenshot` and
// `site pdf`: only-user-set-fields bodies, nested pdf_options, header/cookie/
// basic-auth mapping, the 202 path (--no-wait / --json / --wait+zip), and
// --exit-status on a failed batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  runCli,
  startMockGateway,
  type MockGateway,
  type RecordedRequest,
} from "./helpers/harness.js";

function jsonBodyOf(gw: MockGateway, index = 0): Record<string, unknown> {
  const req: RecordedRequest | undefined = gw.requests[index];
  assert.ok(req !== undefined, `expected a recorded request at index ${index}`);
  assert.ok(req.json !== undefined && req.json !== null, "request body must be JSON");
  return req.json as Record<string, unknown>;
}

function syncEnvelope(gw: MockGateway): Record<string, unknown> {
  return {
    presigned_url: `${gw.url}/presigned/page.pdf`,
    object_key: "prod/files/proj_1/page.pdf",
    filename: "page.pdf",
    file_size: 10,
    conversion_time_seconds: 1.2,
  };
}

test("test_url_pdf_body_contains_url_and_only_user_set_fields", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/url-to-pdf", 200, syncEnvelope(gw));

    const r = await runCli(
      [
        "url", "pdf", "https://example.com",
        "--viewport-width", "1440",
        "--block-ads",
        "--no-single-page",
        "--url-only",
      ],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    const body = jsonBodyOf(gw);
    assert.equal(body["url"], "https://example.com");
    assert.equal(body["viewport_width"], 1440);
    assert.equal(body["block_ads"], true);
    assert.equal(body["single_page"], false);
    assert.equal(typeof body["job_id"], "string", "a crash-recovery job_id is always sent");
    // Gateway defaults the CLI did NOT set must be ABSENT so future
    // server-side default changes are never masked.
    for (const absent of ["load_media", "enable_scroll", "wait_for_images", "handle_sticky_header", "handle_cookies", "viewport_height", "block_media", "async_mode", "pdf_options"]) {
      assert.ok(!(absent in body), `${absent} must not be sent when the user did not set it`);
    }
  } finally {
    await gw.close();
  }
});

test("test_url_pdf_grayscale_sends_pdf_options_as_nested_object", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/url-to-pdf", 200, syncEnvelope(gw));

    const r = await runCli(["url", "pdf", "https://example.com", "--pdf-grayscale", "--url-only"], {
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    const body = jsonBodyOf(gw);
    // Nested OBJECT on URL-render bodies (multipart routes take a JSON string).
    assert.deepEqual(body["pdf_options"], { grayscale: true });
    assert.equal(typeof body["pdf_options"], "object");
  } finally {
    await gw.close();
  }
});

test("test_url_pdf_maps_header_cookie_and_basic_auth_flags", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/url-to-pdf", 200, syncEnvelope(gw));

    const r = await runCli(
      [
        "url", "pdf", "https://example.com",
        "--header", "X-Env: staging",
        "--cookie", "sid=abc123;domain=example.com",
        "--basic-auth", "user:s3cret",
        "--url-only",
      ],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    const body = jsonBodyOf(gw);
    assert.deepEqual(body["headers"], { "X-Env": "staging" });
    assert.deepEqual(body["cookies"], [{ name: "sid", value: "abc123", domain: "example.com" }]);
    assert.deepEqual(body["auth"], { username: "user", password: "s3cret" });
  } finally {
    await gw.close();
  }
});

test("test_url_screenshot_rejects_single_page_with_exit_2", async () => {
  // --single-page applies to url-to-pdf/url-to-markdown only (gateway
  // contract); the screenshot subcommand does not register it, so commander
  // rejects it as an unknown option before any HTTP happens.
  const gw = await startMockGateway();
  try {
    const r = await runCli(["url", "screenshot", "https://example.com", "--single-page"], {
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /unknown option '--single-page'/);
    assert.equal(gw.requests.length, 0);
  } finally {
    await gw.close();
  }
});

test("test_url_pdf_202_with_no_wait_prints_batch_id", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/url-to-pdf", 202, {
      status: "processing",
      batch_id: "batch_ab12cd34",
      url_count: 2,
      output_format: "zip",
    });

    const r = await runCli(
      ["url", "pdf", "https://a.example.com", "https://b.example.com", "--zip", "--no-wait"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "batch_ab12cd34\n", "--no-wait puts the batch id (alone) on stdout");
    assert.match(r.stderr, /enconvert jobs wait batch_ab12cd34/, "the resume command is suggested on stderr");
    assert.equal(gw.requests.length, 1, "--no-wait must not poll");
    const body = jsonBodyOf(gw);
    assert.deepEqual(body["url"], ["https://a.example.com", "https://b.example.com"]);
    assert.equal(body["output_format"], "zip");
  } finally {
    await gw.close();
  }
});

test("test_url_pdf_202_with_json_prints_the_raw_202_body", async () => {
  const gw = await startMockGateway();
  try {
    const accepted = {
      status: "processing",
      batch_id: "batch_json99",
      url_count: 2,
      output_format: "individual",
    };
    gw.json("POST /v1/convert/url-to-pdf", 202, accepted);

    const r = await runCli(
      ["url", "pdf", "https://a.example.com", "https://b.example.com", "--no-wait", "--json"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), accepted);
  } finally {
    await gw.close();
  }
});

test("test_url_pdf_wait_polls_batch_until_completed_and_downloads_the_zip", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/url-to-pdf", 202, {
      status: "processing",
      batch_id: "batch_zip1",
      url_count: 2,
      output_format: "zip",
    });
    let polls = 0;
    gw.route("GET /v1/convert/batch/batch_zip1", (_req, res) => {
      polls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (polls === 1) {
        res.end(JSON.stringify({
          batch_id: "batch_zip1", status: "processing",
          total: 2, completed: 1, failed: 0, in_progress: 1,
          output_mode: "zip", items: [],
        }));
      } else {
        res.end(JSON.stringify({
          batch_id: "batch_zip1", status: "completed",
          total: 2, completed: 2, failed: 0, in_progress: 0,
          output_mode: "zip",
          zip_download_url: `${gw.url}/zips/batch_zip1.zip`,
          items: [],
        }));
      }
    });
    gw.route("GET /zips/batch_zip1.zip", (_req, res) => {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end("PK-zip-bytes");
    });

    const r = await runCli(
      ["url", "pdf", "https://a.example.com", "https://b.example.com", "--zip", "--wait", "--poll-interval", "1"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.ok(polls >= 2, `expected at least two status polls, saw ${polls}`);
    const printed = r.stdout.trim();
    assert.ok(isAbsolute(printed), `stdout must be the absolute zip path, got: ${printed}`);
    assert.ok(printed.endsWith("batch_zip1.zip"));
    assert.equal(readFileSync(printed, "utf8"), "PK-zip-bytes");
  } finally {
    await gw.close();
  }
});

test("test_site_pdf_sends_crawl_fields_and_is_always_202", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/website-to-pdf", 202, {
      status: "processing",
      batch_id: "batch_site7",
      url_count: 14,
      total_discovered: 14,
      discovery_method: "full_crawl",
      output_format: "zip",
    });

    const r = await runCli(
      [
        "site", "pdf", "https://example.com",
        "--crawl-mode", "full",
        "--include-pattern", "/docs/",
        "--exclude-pattern", "\\.png$",
        "--no-wait",
      ],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests.length, 1);
    assert.equal(gw.requests[0]?.path, "/v1/convert/website-to-pdf");
    const body = jsonBodyOf(gw);
    assert.equal(body["url"], "https://example.com");
    assert.equal(body["crawl_mode"], "full");
    assert.deepEqual(body["include_patterns"], ["/docs/"]);
    assert.deepEqual(body["exclude_patterns"], ["\\.png$"]);
    // website-to-* has no async/zip knobs; they must never leak into the body.
    assert.ok(!("async_mode" in body));
    assert.ok(!("output_format" in body));
    assert.ok(!("single_page" in body));
    assert.equal(r.stdout, "batch_site7\n", "the 202 batch id lands on stdout");
  } finally {
    await gw.close();
  }
});

test("test_url_pdf_exit_status_with_failed_batch_exits_9", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/url-to-pdf", 202, {
      status: "processing",
      batch_id: "batch_fail1",
      url_count: 1,
      output_format: "individual",
    });
    gw.json("GET /v1/convert/batch/batch_fail1", 200, {
      batch_id: "batch_fail1",
      status: "failed",
      total: 1,
      completed: 0,
      failed: 1,
      in_progress: 0,
      output_mode: "individual",
      items: [{ source_url: "https://down.example.com", status: "failed" }],
    });

    const r = await runCli(
      ["url", "pdf", "https://down.example.com", "--async", "--wait", "--exit-status", "--json"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 9, `--exit-status on a failed batch must exit 9, got ${r.code}: ${r.stderr}`);
    const batch = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(batch["status"], "failed");
  } finally {
    await gw.close();
  }
});
