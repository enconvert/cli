// `enconvert api` — gh-api-vocabulary passthrough goldens: field parsing and
// magic typing, body-vs-query placement, multipart detection from the bundled
// index, headers, --jq/-i/--silent, error exit mapping, skip/limit pagination,
// and the offline index modes (--list-endpoints/--search/--describe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  field,
  parseMultipart,
  runCli,
  scratchDir,
  startMockGateway,
  type MockGateway,
} from "./helpers/harness.js";

function jsonBodyOf(gw: MockGateway, index = 0): Record<string, unknown> {
  const req = gw.requests[index];
  assert.ok(req !== undefined, `expected a recorded request at index ${index}`);
  assert.ok(req.json !== undefined, `request body must be JSON, got: ${req.body.toString("utf8")}`);
  return req.json as Record<string, unknown>;
}

test("test_raw_field_is_always_a_string_and_fields_auto_post", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v2/perceive", 200, { operation_id: "per_1", status: "completed" });
    const r = await runCli(
      ["api", "/v2/perceive", "-f", "url=https://example.com", "-f", "count=5"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    const req = gw.requests[0]!;
    assert.equal(req.method, "POST", "field flags without -X must auto-POST");
    assert.ok(String(req.headers["content-type"]).includes("application/json"));
    // -f never magic-types: "5" stays a string.
    assert.deepEqual(jsonBodyOf(gw), { url: "https://example.com", count: "5" });
  } finally {
    await gw.close();
  }
});

test("test_typed_field_magic_types_bool_null_int_file_and_stdin", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "data.txt"), "FILE DATA");
    gw.json("POST /v2/discover", 200, { ok: true });
    const r = await runCli(
      [
        "api", "/v2/discover",
        "-F", "flag_true=true",
        "-F", "flag_false=false",
        "-F", "nothing=null",
        "-F", "n=42",
        "-F", "s=hello",
        "-F", "fromfile=@data.txt",
        "-F", "fromstdin=@-",
      ],
      { home, stdin: "STDIN DATA", env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(jsonBodyOf(gw), {
      flag_true: true,
      flag_false: false,
      nothing: null,
      n: 42,
      s: "hello",
      fromfile: "FILE DATA",
      fromstdin: "STDIN DATA",
    });
  } finally {
    await gw.close();
  }
});

test("test_bracket_field_keys_build_nested_objects_and_arrays", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v2/discover", 200, { ok: true });
    const r = await runCli(
      ["api", "/v2/discover", "-F", "k[a]=1", "-F", "k[b][]=x", "-F", "k[b][]=y"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(jsonBodyOf(gw), { k: { a: 1, b: ["x", "y"] } });
  } finally {
    await gw.close();
  }
});

test("test_no_fields_defaults_to_get", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_1", plan_slug: "pro" });
    const r = await runCli(["api", "/v1/whoami"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.method, "GET");
    assert.deepEqual(JSON.parse(r.stdout), { project_id: "proj_1", plan_slug: "pro" });
  } finally {
    await gw.close();
  }
});

test("test_fields_become_query_parameters_on_get", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v2/ingest", 200, { jobs: [], skip: 0, limit: 5, has_more: false });
    const r = await runCli(
      ["api", "/v2/ingest", "-X", "GET", "-F", "limit=5", "-f", "q=x"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    const req = gw.requests[0]!;
    assert.equal(req.method, "GET");
    assert.equal(req.query.get("limit"), "5");
    assert.equal(req.query.get("q"), "x");
    assert.equal(req.body.length, 0, "GET must not carry a body");
  } finally {
    await gw.close();
  }
});

test("test_input_file_becomes_the_json_body_and_fields_become_query", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    const doc = { mode: "urls", urls: ["https://a.example.com"], chunk: { max_words: 256 } };
    writeFileSync(join(home, "body.json"), JSON.stringify(doc));
    gw.json("POST /v2/ingest", 202, { job_id: "ing_1", status: "queued" });
    const r = await runCli(
      ["api", "/v2/ingest", "--input", "body.json", "-F", "skip=1"],
      { home, env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    const req = gw.requests[0]!;
    assert.equal(req.method, "POST", "--input defaults the method to POST");
    assert.deepEqual(req.json, doc, "the file is sent verbatim as the JSON body");
    assert.equal(req.query.get("skip"), "1", "field flags shift to the query string with --input");
  } finally {
    await gw.close();
  }
});

test("test_explicit_method_delete_is_sent", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("DELETE /v2/perceive/batch/batch_1", 200, { job_id: "batch_1", status: "canceled" });
    const r = await runCli(
      ["api", "/v2/perceive/batch/batch_1", "-X", "DELETE"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.method, "DELETE");
    assert.equal(gw.requests[0]?.path, "/v2/perceive/batch/batch_1");
  } finally {
    await gw.close();
  }
});

test("test_multipart_detection_on_upload_route_sends_the_file_part", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "doc.md"), "# hello");
    gw.json("POST /v1/convert/anything-to-pdf", 200, {
      presigned_url: "https://storage.example.com/doc.pdf",
      object_key: "k",
      filename: "doc.pdf",
      file_size: 5,
      conversion_time_seconds: 0.1,
    });
    const r = await runCli(
      ["api", "/v1/convert/anything-to-pdf", "-F", "file=@doc.md", "-f", "direct_download=false"],
      { home, env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    const req = gw.requests[0]!;
    assert.ok(
      String(req.headers["content-type"]).includes("multipart/form-data"),
      "the bundled index marks this endpoint multipart; -F file=@ must upload a form",
    );
    const fields = parseMultipart(req.body, String(req.headers["content-type"]));
    const file = field(fields, "file");
    assert.ok(file !== undefined, "the file part must be present");
    assert.equal(file.filename, "doc.md");
    assert.equal(file.value.toString("utf8"), "# hello");
    assert.equal(field(fields, "direct_download")?.value.toString("utf8"), "false");
  } finally {
    await gw.close();
  }
});

test("test_custom_header_reaches_the_gateway", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_1", plan_slug: "pro" });
    const r = await runCli(
      ["api", "/v1/whoami", "-H", "X-Custom: yes-indeed"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.headers["x-custom"], "yes-indeed");
  } finally {
    await gw.close();
  }
});

test("test_jq_extracts_a_raw_string_from_the_response", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_1", plan_slug: "pro" });
    const r = await runCli(
      ["api", "/v1/whoami", "--jq", ".plan_slug"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "pro\n", "gh-style: string results print raw, unquoted");
  } finally {
    await gw.close();
  }
});

test("test_include_prints_http_status_and_headers_before_the_body", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_1", plan_slug: "pro" }, { "x-served-by": "mock" });
    const r = await runCli(["api", "/v1/whoami", "-i"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith("HTTP/200\n"), `stdout must open with the status line, got: ${r.stdout.slice(0, 40)}`);
    assert.match(r.stdout, /^x-served-by: mock$/m);
    assert.match(r.stdout, /"plan_slug": "pro"/, "the body still follows the head");
  } finally {
    await gw.close();
  }
});

test("test_error_status_prints_the_body_and_maps_402_to_exit_6", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 402, { detail: "Monthly conversion limit reached" });
    const r = await runCli(["api", "/v1/whoami"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 6, `402 must map to exit 6, got ${r.code}: ${r.stderr}`);
    assert.match(r.stdout, /Monthly conversion limit reached/, "the error body is still printed");
  } finally {
    await gw.close();
  }
});

test("test_silent_suppresses_the_body_but_keeps_the_exit_code", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 402, { detail: "Monthly conversion limit reached" });
    const r = await runCli(["api", "/v1/whoami", "--silent"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(r.code, 6, "--silent must not change the exit mapping");
    assert.equal(r.stdout, "", "--silent suppresses the response body");
  } finally {
    await gw.close();
  }
});

test("test_paginate_slurp_follows_has_more_across_three_pages", async () => {
  const gw = await startMockGateway();
  try {
    const pages: Record<string, unknown>[] = [
      { jobs: [{ job_id: "ing_a" }, { job_id: "ing_b" }], skip: 0, limit: 2, has_more: true },
      { jobs: [{ job_id: "ing_c" }, { job_id: "ing_d" }], skip: 2, limit: 2, has_more: true },
      { jobs: [{ job_id: "ing_e" }], skip: 4, limit: 2, has_more: false },
    ];
    gw.route("GET /v2/ingest", (req, res) => {
      const skip = Number(req.query.get("skip") ?? "0");
      const page = pages[Math.floor(skip / 2)] ?? { jobs: [], skip, limit: 2, has_more: false };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page));
    });

    const r = await runCli(
      ["api", "/v2/ingest", "--paginate", "--slurp"],
      { env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests.length, 3, "has_more:true twice -> exactly three GETs");
    assert.equal(gw.requests[1]?.query.get("skip"), "2", "the second page advances skip by the page length");
    assert.equal(gw.requests[2]?.query.get("skip"), "4");
    assert.deepEqual(JSON.parse(r.stdout), pages, "--slurp wraps all pages in one JSON array");
  } finally {
    await gw.close();
  }
});

test("test_list_endpoints_works_offline_without_key_or_server", async () => {
  const r = await runCli(["api", "--list-endpoints"], {
    // No key, no reachable server: the index is bundled.
    env: { ENCONVERT_API_KEY: undefined, ENCONVERT_API_URL: "http://127.0.0.1:9" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST\s+\/v2\/perceive/);
  assert.match(r.stdout, /GET\s+\/v1\/whoami/);
});

test("test_search_works_offline", async () => {
  const r = await runCli(["api", "--search", "perceive"], {
    env: { ENCONVERT_API_KEY: undefined, ENCONVERT_API_URL: "http://127.0.0.1:9" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\/v2\/perceive\/batch/);
  assert.ok(!r.stdout.includes("/v1/whoami"), "search must filter to matching endpoints");
});

test("test_describe_works_offline", async () => {
  const r = await runCli(["api", "--describe", "/v2/distill"], {
    env: { ENCONVERT_API_KEY: undefined, ENCONVERT_API_URL: "http://127.0.0.1:9" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST \/v2\/distill/);
  assert.match(r.stdout, /body:\s+application\/json/);
});
