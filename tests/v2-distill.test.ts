// Request-shape goldens + rendering for `enconvert distill` (POST /v2/distill).
// Contract: .spec/api-contract.md §8.8 — urls XOR discover_from, schema or
// prompt required; both rules are enforced client-side (exit 2, no request).
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  runCli,
  scratchDir,
  startMockGateway,
  TEST_KEY,
  type MockGateway,
} from "./helpers/harness.js";

function envFor(gw: MockGateway): Record<string, string> {
  return { ENCONVERT_API_URL: gw.url };
}

function distillResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: "dst_ab12cd34",
    total: 1,
    completed: 1,
    failed: 0,
    results: [
      { url: "https://a.com", status: "completed", data: { name: "x" }, extraction_tier: "llm" },
    ],
    warnings: [],
    ...overrides,
  };
}

test("test_urls_with_schema_file_golden_body", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, distillResponse());

  const home = scratchDir();
  const schema = { type: "object", properties: { price: { type: "number" } } };
  const schemaPath = join(home, "s.json");
  writeFileSync(schemaPath, JSON.stringify(schema));

  const res = await runCli(
    ["distill", "https://a.com", "https://b.com", "--schema-file", schemaPath, "--json"],
    { env: envFor(gw), home },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  const req = gw.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v2/distill");
  assert.equal(req.headers["x-api-key"], TEST_KEY);
  assert.deepEqual(req.json, { urls: ["https://a.com", "https://b.com"], schema });
});

test("test_prompt_only_golden_body", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, distillResponse());

  const res = await runCli(
    ["distill", "https://a.com", "--prompt", "name and price", "--json"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(gw.requests[0]!.json, { urls: ["https://a.com"], prompt: "name and price" });
});

test("test_discover_from_with_flags_sends_discover_from_and_no_urls_key", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, distillResponse());

  const res = await runCli(
    [
      "distill",
      "--discover-from", "https://shop.com",
      "--discover-mode", "sitemap",
      "--discover-max-pages", "25",
      "--prompt", "product name and price",
      "--json",
    ],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  const body = gw.requests[0]!.json as Record<string, unknown>;
  // deepEqual proves discover_from is complete AND urls is absent.
  assert.deepEqual(body, {
    discover_from: { url: "https://shop.com", mode: "sitemap", max_pages: 25 },
    prompt: "product name and price",
  });
  assert.ok(!("urls" in body), "urls key must be absent in discover_from mode");
});

test("test_urls_and_discover_from_together_exit_2_without_request", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, distillResponse());

  const res = await runCli(
    ["distill", "https://a.com", "--discover-from", "https://shop.com", "--prompt", "p"],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0, "XOR violation must fail offline");
  assert.match(res.stderr, /not both/);
});

test("test_neither_schema_nor_prompt_exit_2_without_request", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, distillResponse());

  const res = await runCli(["distill", "https://a.com"], { env: envFor(gw) });

  assert.equal(res.code, 2);
  assert.equal(gw.requests.length, 0);
  assert.match(res.stderr, /--schema-file or --prompt/);
});

test("test_css_schema_file_passthrough_verbatim", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, distillResponse());

  const home = scratchDir();
  const cssSchema = {
    baseSelector: ".item",
    name: "items",
    fields: [
      { name: "title", type: "text", selector: "h2" },
      { name: "link", type: "attribute", selector: "a", attribute: "href" },
    ],
  };
  const cssPath = join(home, "css.json");
  writeFileSync(cssPath, JSON.stringify(cssSchema));

  const res = await runCli(
    ["distill", "https://a.com", "--css-schema-file", cssPath, "--prompt", "p", "--json"],
    { env: envFor(gw), home },
  );

  assert.equal(res.code, 0, res.stderr);
  const body = gw.requests[0]!.json as Record<string, unknown>;
  // Verbatim passthrough — no key renaming (baseSelector stays camelCase).
  assert.deepEqual(body["css_schema"], cssSchema);
  assert.deepEqual(body, { urls: ["https://a.com"], prompt: "p", css_schema: cssSchema });
});

test("test_results_data_as_json_lines_on_stdout_failed_items_on_stderr", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, {
    operation_id: "dst_9",
    total: 2,
    completed: 1,
    failed: 1,
    results: [
      { url: "https://a.com", status: "completed", data: { a: 1 }, extraction_tier: "css" },
      { url: "https://b.com", status: "failed", error: "boom" },
    ],
    warnings: [],
  });

  const res = await runCli(["distill", "https://a.com", "https://b.com", "--prompt", "p"], {
    env: envFor(gw),
  });

  assert.equal(res.code, 0, res.stderr);
  // stdout: one compact JSON line per result's data (null for the failed one).
  const lines = res.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { a: 1 });
  assert.equal(JSON.parse(lines[1]!), null);
  // Failure surfaced on stderr with url, status, tier, and error.
  assert.match(res.stderr, /https:\/\/b\.com -> failed \(none\): boom/);
  assert.match(res.stderr, /dst_9: 1\/2 completed, 1 failed/);
});

test("test_synthesized_schema_present_verbatim_under_json", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const synthesized = {
    type: "object",
    properties: { name: { type: "string" }, price: { type: "number" } },
  };
  const response = distillResponse({ synthesized_schema: synthesized });
  gw.json("POST /v2/distill", 200, response);

  const res = await runCli(["distill", "https://a.com", "--prompt", "name and price", "--json"], {
    env: envFor(gw),
  });

  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.deepEqual(parsed["synthesized_schema"], synthesized);
  assert.deepEqual(parsed, response);
});

test("test_extract_alias_posts_to_v2_distill", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/distill", 200, distillResponse());

  const res = await runCli(["extract", "https://a.com", "--prompt", "p", "--json"], {
    env: envFor(gw),
  });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.path, "/v2/distill");
  assert.deepEqual(gw.requests[0]!.json, { urls: ["https://a.com"], prompt: "p" });
});
