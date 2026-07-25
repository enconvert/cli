// `jobs get|batch|wait` and `files download`: verbatim --json passthrough of
// the gateway status shapes, id-prefix routing in `jobs wait` (batch_ tries v2
// perceive first, 404 falls back to v1), --wait-timeout resume hint, honoured
// Retry-After, and X-Filename-named downloads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  runCli,
  scratchDir,
  startMockGateway,
} from "./helpers/harness.js";

const BATCH_SHAPE = {
  batch_id: "batch_t1",
  status: "completed",
  total: 2,
  completed: 2,
  failed: 0,
  in_progress: 0,
  output_mode: "individual",
  items: [
    { source_url: "https://a.example.com/x", status: "completed", download_url: "https://cdn.example.com/a.pdf", output_file_size: 1024, duration: 3 },
    { source_url: "https://b.example.com/y", status: "completed", download_url: "https://cdn.example.com/b.pdf", output_file_size: 2048, duration: 5 },
  ],
};

test("test_jobs_get_processing_shape_verbatim_under_json", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/convert/status/job_p1", 200, { status: "processing" });
    const r = await runCli(["jobs", "get", "job_p1", "--json"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { status: "processing" });
  } finally {
    await gw.close();
  }
});

test("test_jobs_get_success_shape_verbatim_under_json", async () => {
  const gw = await startMockGateway();
  try {
    const body = {
      status: "success",
      presigned_url: "https://storage.example.com/out.pdf?sig=abc",
      object_key: "prod/files/proj_1/out.pdf",
    };
    gw.json("GET /v1/convert/status/job_s1", 200, body);
    const r = await runCli(["jobs", "get", "job_s1", "--json"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), body);
  } finally {
    await gw.close();
  }
});

test("test_jobs_get_failed_shape_verbatim_under_json", async () => {
  const gw = await startMockGateway();
  try {
    const body = { status: "failed", error: "LibreOffice timed out after 300s" };
    gw.json("GET /v1/convert/status/job_f1", 200, body);
    const r = await runCli(["jobs", "get", "job_f1", "--json"], { env: { ENCONVERT_API_URL: gw.url } });
    // jobs get reports a failed job; it does not fail itself.
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), body);
  } finally {
    await gw.close();
  }
});

test("test_jobs_batch_renders_summary_and_item_table", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/convert/batch/batch_t1", 200, BATCH_SHAPE);
    const r = await runCli(["jobs", "batch", "batch_t1"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /batch batch_t1: completed \(2\/2 done, 0 failed, 0 running, output individual\)/);
    // Table header + per-item rows.
    assert.match(r.stdout, /url\s+status\s+size\s+duration/);
    assert.match(r.stdout, /https:\/\/a\.example\.com\/x\s+completed\s+1\.0 KB\s+3s/);
    assert.match(r.stdout, /https:\/\/b\.example\.com\/y\s+completed\s+2\.0 KB\s+5s/);
  } finally {
    await gw.close();
  }
});

test("test_jobs_batch_json_is_the_raw_batch_shape", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/convert/batch/batch_t1", 200, BATCH_SHAPE);
    const r = await runCli(["jobs", "batch", "batch_t1", "--json"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), BATCH_SHAPE);
  } finally {
    await gw.close();
  }
});

test("test_jobs_wait_bare_id_polls_v1_convert_status", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/convert/status/4f1c9aplainid", 200, {
      status: "success",
      presigned_url: "https://storage.example.com/done.pdf",
      object_key: "prod/files/proj_1/done.pdf",
    });
    const r = await runCli(["jobs", "wait", "4f1c9aplainid"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.method, "GET");
    assert.equal(gw.requests[0]?.path, "/v1/convert/status/4f1c9aplainid");
    assert.equal(r.stdout, "https://storage.example.com/done.pdf\n", "the final URL lands on stdout");
  } finally {
    await gw.close();
  }
});

test("test_jobs_wait_batch_id_polls_v2_perceive_batch_first_then_falls_back_to_v1_on_404", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v2/perceive/batch/batch_amb1", 404, { detail: "Batch not found" });
    gw.json("GET /v1/convert/batch/batch_amb1", 200, {
      batch_id: "batch_amb1",
      status: "completed",
      total: 1,
      completed: 1,
      failed: 0,
      in_progress: 0,
      output_mode: "zip",
      zip_download_url: "https://storage.example.com/batch_amb1.zip",
      items: [],
    });
    const r = await runCli(["jobs", "wait", "batch_amb1", "--json"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    const paths = gw.requests.map((q) => q.path);
    assert.equal(paths[0], "/v2/perceive/batch/batch_amb1", "v2 perceive batch must be tried FIRST");
    assert.ok(paths.includes("/v1/convert/batch/batch_amb1"), "must fall back to the v1 batch endpoint on 404");
    assert.ok(
      paths.indexOf("/v2/perceive/batch/batch_amb1") < paths.indexOf("/v1/convert/batch/batch_amb1"),
      "fallback order must be v2 then v1",
    );
    assert.equal((JSON.parse(r.stdout) as Record<string, unknown>)["batch_id"], "batch_amb1");
  } finally {
    await gw.close();
  }
});

test("test_jobs_wait_ing_id_polls_v2_ingest", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v2/ingest/ing_ab12cd34", 200, {
      job_id: "ing_ab12cd34",
      status: "completed",
      mode: "urls",
      pages_discovered: 3,
      pages_processed: 3,
      pages_failed: 0,
      total_chunks: 42,
      output_url: "https://storage.example.com/ing_ab12cd34.jsonl",
      webhook_delivered: false,
      warnings: [],
    });
    const r = await runCli(["jobs", "wait", "ing_ab12cd34"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.path, "/v2/ingest/ing_ab12cd34");
    assert.equal(r.stdout, "https://storage.example.com/ing_ab12cd34.jsonl\n");
  } finally {
    await gw.close();
  }
});

test("test_jobs_wait_dst_id_exits_2_because_distill_is_synchronous", async () => {
  const gw = await startMockGateway();
  try {
    const r = await runCli(["jobs", "wait", "dst_deadbeef"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /synchronous/);
    assert.equal(gw.requests.length, 0, "nothing to poll — no HTTP at all");
  } finally {
    await gw.close();
  }
});

test("test_jobs_wait_exit_status_on_failed_job_exits_9", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/convert/status/jobfailed1", 200, { status: "failed", error: "conversion blew up" });
    const r = await runCli(["jobs", "wait", "jobfailed1", "--exit-status", "--json"], {
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(r.code, 9, `--exit-status on a failed job must exit 9, got ${r.code}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { status: "failed", error: "conversion blew up" });
  } finally {
    await gw.close();
  }
});

test("test_jobs_wait_timeout_exits_10_and_prints_the_resume_command", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/convert/status/myjobslow", 200, { status: "processing" });
    const r = await runCli(["jobs", "wait", "myjobslow", "--wait-timeout", "1s"], {
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(r.code, 10, `wait timeout must exit 10, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /enconvert jobs wait myjobslow/, "the resume command must be printed");
  } finally {
    await gw.close();
  }
});

test("test_jobs_wait_honours_retry_after_on_429_then_succeeds", async () => {
  const gw = await startMockGateway();
  try {
    let calls = 0;
    gw.route("GET /v1/convert/status/jobrate1", (_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ detail: "Rate limit exceeded. Please slow down and retry shortly." }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", presigned_url: "https://storage.example.com/r.pdf", object_key: "k" }));
    });

    const started = Date.now();
    const r = await runCli(["jobs", "wait", "jobrate1"], { env: { ENCONVERT_API_URL: gw.url } });
    const elapsed = Date.now() - started;

    assert.equal(r.code, 0, `must recover after the 429: ${r.stderr}`);
    assert.ok(calls >= 2, `expected a retry after the 429, saw ${calls} calls`);
    assert.ok(elapsed >= 900, `Retry-After: 1 must delay ~1s before retrying (took ${elapsed}ms)`);
    assert.equal(r.stdout, "https://storage.example.com/r.pdf\n");
  } finally {
    await gw.close();
  }
});

test("test_files_download_writes_bytes_under_the_x_filename_name", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    gw.route("GET /v1/convert/download/prod/files/proj_1/report.pdf", (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'inline; filename="converted report-1.pdf"',
        "x-filename": "converted report-1.pdf",
      });
      res.end("FILE-BYTES");
    });

    const r = await runCli(["files", "download", "prod/files/proj_1/report.pdf"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    const printed = r.stdout.trim();
    assert.ok(isAbsolute(printed), `stdout must be an absolute path, got: ${printed}`);
    assert.ok(printed.endsWith("converted report-1.pdf"), `the X-Filename name must be used, got: ${printed}`);
    assert.equal(readFileSync(printed, "utf8"), "FILE-BYTES");
    assert.equal(readFileSync(join(home, "converted report-1.pdf"), "utf8"), "FILE-BYTES");
  } finally {
    await gw.close();
  }
});

test("test_files_download_dash_streams_bytes_to_stdout", async () => {
  const gw = await startMockGateway();
  try {
    gw.route("GET /v1/convert/download/prod/files/proj_1/report.pdf", (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "x-filename": "report.pdf" });
      res.end("RAW-STREAMED-BYTES");
    });

    const r = await runCli(["files", "download", "prod/files/proj_1/report.pdf", "-o", "-"], {
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "RAW-STREAMED-BYTES", "-o - must emit exactly the object bytes");
  } finally {
    await gw.close();
  }
});
