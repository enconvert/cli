// Request-shape goldens + job flow for the `enconvert ingest` family
// (/v2/ingest, /v2/ingest/files, list/get/cancel, retry-webhook,
// webhook-secret). Contract: .spec/api-contract.md §8.9.
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  field,
  parseMultipart,
  runCli,
  scratchDir,
  startMockGateway,
  TEST_KEY,
  type MockGateway,
} from "./helpers/harness.js";

function envFor(gw: MockGateway): Record<string, string> {
  return { ENCONVERT_API_URL: gw.url };
}

function queuedJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "ing_ab12cd34",
    status: "queued",
    mode: "urls",
    pages_discovered: 0,
    pages_processed: 0,
    pages_failed: 0,
    total_chunks: 0,
    webhook_delivered: false,
    warnings: [],
    ...overrides,
  };
}

// --- create -----------------------------------------------------------------

test("test_create_urls_mode_sends_urls_array_and_no_url_or_mode_keys", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest", 202, queuedJob());

  const res = await runCli(
    ["ingest", "create", "https://a.com", "https://b.com", "--no-wait"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  const req = gw.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v2/ingest");
  assert.equal(req.headers["x-api-key"], TEST_KEY);
  // Deliberate CLI choice: without --mode, only {urls} is sent so the server
  // default ("urls") stays in charge — no mode, no url key.
  assert.deepEqual(req.json, { urls: ["https://a.com", "https://b.com"] });
  // --no-wait prints the ing_ handle on stdout.
  assert.equal(res.stdout, "ing_ab12cd34\n");
});

test("test_create_sitemap_mode_golden_body_differs_from_urls_mode", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest", 202, queuedJob({ mode: "sitemap" }));

  const res = await runCli(
    [
      "ingest", "create", "https://example.com/sitemap.xml",
      "--mode", "sitemap",
      "--max-pages", "200",
      "--max-depth", "3",
      "--chunk-max-words", "400",
      "--chunk-sentence-overlap", "2",
      "--webhook-url", "https://h/x",
      "--no-wait",
    ],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  const body = gw.requests[0]!.json as Record<string, unknown>;
  assert.deepEqual(body, {
    mode: "sitemap",
    url: "https://example.com/sitemap.xml",
    max_pages: 200,
    max_depth: 3,
    chunk: { max_words: 400, sentence_overlap: 2 },
    webhook_url: "https://h/x",
  });
  // Seed-URL modes send `url`, never `urls` — the exact inverse of urls mode.
  assert.ok(!("urls" in body));
});

test("test_create_crawl_mode_with_include_exclude_patterns", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest", 202, queuedJob({ mode: "crawl" }));

  const res = await runCli(
    [
      "ingest", "create", "https://example.com",
      "--mode", "crawl",
      "--include-pattern", "/blog/",
      "--exclude-pattern", "\\.pdf$",
      "--no-wait",
    ],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(gw.requests[0]!.json, {
    mode: "crawl",
    url: "https://example.com",
    include_patterns: ["/blog/"],
    exclude_patterns: ["\\.pdf$"],
  });
});

test("test_multiple_urls_with_crawl_mode_exit_2_without_request", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest", 202, queuedJob());

  const res = await runCli(
    ["ingest", "create", "https://a.com", "https://b.com", "--mode", "crawl", "--no-wait"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0, "seed-mode arity must be validated offline");
  assert.match(res.stderr, /crawl mode takes exactly one seed URL \(got 2\)/);
});

test("test_url_file_reads_urls_skipping_comments", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest", 202, queuedJob());

  const home = scratchDir();
  const urlFile = join(home, "urls.txt");
  writeFileSync(urlFile, "# seeds\nhttps://a.com/1\n\n# more\nhttps://a.com/2\n");

  const res = await runCli(["ingest", "create", "--url-file", urlFile, "--no-wait"], {
    env: envFor(gw),
    home,
  });

  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(gw.requests[0]!.json, { urls: ["https://a.com/1", "https://a.com/2"] });
});

test("test_create_wait_polls_get_to_completed_and_prints_output_url", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest", 202, queuedJob({ job_id: "ing_9" }));
  const outputUrl = "https://cdn.example/ing_9.jsonl";
  let polls = 0;
  gw.route("GET /v2/ingest/ing_9", (_req, res) => {
    polls += 1;
    const status = polls === 1 ? "queued" : polls === 2 ? "processing" : "completed";
    const payload = queuedJob({
      job_id: "ing_9",
      status,
      ...(status === "completed"
        ? { pages_discovered: 2, pages_processed: 2, total_chunks: 10, output_url: outputUrl }
        : {}),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  const res = await runCli(
    ["ingest", "create", "https://a.com", "--wait", "--poll-interval", "1"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.ok(polls >= 3, `expected queued -> processing -> completed polls, saw ${polls}`);
  const polled = gw.requests.filter((r) => r.method === "GET" && r.path === "/v2/ingest/ing_9");
  assert.ok(polled.length >= 3);
  assert.equal(res.stdout, outputUrl + "\n");
  assert.match(res.stderr, /ingest ing_9: completed \(2\/2 pages, 10 chunks\)/);
});

// --- files ------------------------------------------------------------------

test("test_files_multipart_has_both_parts_named_files_plus_fields", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest/files", 202, queuedJob({ job_id: "ing_f", mode: "files" }));

  const home = scratchDir();
  const aPath = join(home, "a.md");
  const bPath = join(home, "b.md");
  writeFileSync(aPath, "hello a");
  writeFileSync(bPath, "hello b");

  const res = await runCli(
    [
      "ingest", "files", aPath, bPath,
      "--max-words", "400",
      "--sentence-overlap", "2",
      "--webhook-url", "https://h/x",
      "--no-wait",
    ],
    { env: envFor(gw), home },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  const req = gw.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v2/ingest/files");
  const contentType = String(req.headers["content-type"]);
  assert.match(contentType, /^multipart\/form-data/);

  const parts = parseMultipart(req.body, contentType);
  const fileParts = parts.filter((p) => p.name === "files");
  assert.equal(fileParts.length, 2, "both files must be sent as parts named 'files'");
  assert.deepEqual(
    fileParts.map((p) => p.filename).sort(),
    ["a.md", "b.md"],
  );
  assert.deepEqual(
    fileParts.map((p) => p.value.toString("utf8")).sort(),
    ["hello a", "hello b"],
  );
  assert.equal(field(parts, "max_words")?.value.toString("utf8"), "400");
  assert.equal(field(parts, "sentence_overlap")?.value.toString("utf8"), "2");
  assert.equal(field(parts, "webhook_url")?.value.toString("utf8"), "https://h/x");
  assert.equal(res.stdout, "ing_f\n");
});

test("test_more_than_200_files_exit_2_without_request", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest/files", 202, queuedJob());

  // 201 paths: the count gate fires before any file is opened, so the paths
  // do not need to exist — this keeps the test fast.
  const paths = Array.from({ length: 201 }, (_, i) => `f${i}.md`);
  const res = await runCli(["ingest", "files", ...paths, "--no-wait"], { env: envFor(gw) });

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0, "count must be validated client-side");
  assert.match(res.stderr, /too many files \(201\).*at most 200/);
});

// --- list / get / cancel / retry-webhook ------------------------------------

test("test_list_sends_skip_limit_query_params_and_jsonl_streams_jobs", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("GET /v2/ingest", 200, {
    jobs: [
      queuedJob({ job_id: "ing_1", status: "completed" }),
      queuedJob({ job_id: "ing_2", status: "queued" }),
    ],
    skip: 5,
    limit: 50,
    has_more: false,
  });

  const res = await runCli(["ingest", "list", "--skip", "5", "--limit", "50", "--jsonl"], {
    env: envFor(gw),
  });

  assert.equal(res.code, 0, res.stderr);
  const req = gw.requests[0]!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v2/ingest");
  assert.equal(req.query.get("skip"), "5");
  assert.equal(req.query.get("limit"), "50");
  const lines = res.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, "--jsonl must emit one line per job");
  assert.equal((JSON.parse(lines[0]!) as { job_id: string }).job_id, "ing_1");
  assert.equal((JSON.parse(lines[1]!) as { job_id: string }).job_id, "ing_2");
});

test("test_get_hits_get_ingest_id", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("GET /v2/ingest/ing_1", 200, queuedJob({ job_id: "ing_1", status: "completed" }));

  const res = await runCli(["ingest", "get", "ing_1", "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.method, "GET");
  assert.equal(gw.requests[0]!.path, "/v2/ingest/ing_1");
});

test("test_cancel_sends_delete_to_ingest_id", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("DELETE /v2/ingest/ing_1", 200, queuedJob({ job_id: "ing_1", status: "canceled" }));

  const res = await runCli(["ingest", "cancel", "ing_1"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.method, "DELETE");
  assert.equal(gw.requests[0]!.path, "/v2/ingest/ing_1");
  assert.match(res.stderr, /ingest ing_1: canceled/);
});

test("test_retry_webhook_posts_to_retry_webhook_path", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest/ing_1/retry-webhook", 200, {
    job_id: "ing_1",
    delivered: true,
    attempts: 1,
    status_code: 200,
    detail: "",
  });

  const res = await runCli(["ingest", "retry-webhook", "ing_1"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.method, "POST");
  assert.equal(gw.requests[0]!.path, "/v2/ingest/ing_1/retry-webhook");
  assert.match(res.stderr, /webhook delivered after 1 attempt\(s\) \(HTTP 200\)/);
});

test("test_retry_webhook_409_surfaces_detail_with_nonzero_exit", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest/ing_1/retry-webhook", 409, {
    detail: "Job is not completed yet",
  });

  const res = await runCli(["ingest", "retry-webhook", "ing_1"], { env: envFor(gw) });

  assert.notEqual(res.code, 0, "409 must not exit 0");
  assert.match(res.stderr, /Job is not completed yet/);
  // The CLI adds the actionable context for 409s.
  assert.match(res.stderr, /webhooks can only be retried once the job's status is completed/);
  assert.match(res.stderr, /enconvert ingest get ing_1/);
});

// --- webhook-secret ---------------------------------------------------------

function secretResponse(rotated: boolean): Record<string, unknown> {
  return {
    secret: "whsec_abc123",
    signature_header: "X-Enconvert-Signature",
    timestamp_header: "X-Enconvert-Timestamp",
    signature_scheme: "sha256",
    replay_tolerance_seconds: 300,
    rotated,
  };
}

test("test_webhook_secret_show_prints_secret_on_stdout", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("GET /v2/ingest/webhook-secret", 200, secretResponse(false));

  const res = await runCli(["ingest", "webhook-secret", "show"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.method, "GET");
  assert.equal(gw.requests[0]!.path, "/v2/ingest/webhook-secret");
  // Secret alone on stdout (scriptable); headers explained on stderr.
  assert.equal(res.stdout, "whsec_abc123\n");
  assert.match(res.stderr, /X-Enconvert-Signature/);
  assert.match(res.stderr, /X-Enconvert-Timestamp/);
});

test("test_webhook_secret_rotate_without_yes_noninteractive_exits_2", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest/webhook-secret/rotate", 200, secretResponse(true));

  // Harness runs are non-interactive (piped stdio, CI=1): the confirmation
  // cannot be answered, so the CLI must refuse with exit 2 and never POST.
  const res = await runCli(["ingest", "webhook-secret", "rotate"], { env: envFor(gw) });

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0, "rotate must not fire without confirmation");
  assert.match(res.stderr, /confirmation required/);
  assert.match(res.stderr, /-y\/--yes/);
});

test("test_webhook_secret_rotate_with_yes_posts_rotate", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/ingest/webhook-secret/rotate", 200, secretResponse(true));

  const res = await runCli(["ingest", "webhook-secret", "rotate", "--yes"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.method, "POST");
  assert.equal(gw.requests[0]!.path, "/v2/ingest/webhook-secret/rotate");
  assert.equal(res.stdout, "whsec_abc123\n");
  assert.match(res.stderr, /secret rotated; update every webhook consumer now/);
});
