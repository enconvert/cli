// Request-shape goldens + rendering for `enconvert discover` (POST /v2/discover)
// and `enconvert lookup` (POST /v2/lookup). Contract: .spec/api-contract.md §8.6-8.7.
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

// --- discover ---------------------------------------------------------------

test("test_discover_full_flags_golden_body", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/discover", 200, {
    url: "https://example.com",
    mode: "crawl",
    total: 0,
    urls: [],
  });

  const res = await runCli(
    [
      "discover", "https://example.com",
      "--mode", "crawl",
      "--max-urls", "500",
      "--max-depth", "3",
      "--include-pattern", "a",
      "--include-pattern", "b",
      "--exclude-pattern", "c",
      "--no-same-domain-only",
      "--respect-robots",
      "--render-js", "always",
      "--json",
    ],
    { env: envFor(gw) },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  const req = gw.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v2/discover");
  assert.equal(req.headers["x-api-key"], TEST_KEY);
  assert.deepEqual(req.json, {
    url: "https://example.com",
    mode: "crawl",
    max_urls: 500,
    max_depth: 3,
    include_patterns: ["a", "b"],
    exclude_patterns: ["c"],
    same_domain_only: false,
    respect_robots: true,
    render_js: "always",
  });
});

test("test_bare_discover_sends_url_only", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/discover", 200, {
    url: "https://example.com",
    mode: "hybrid",
    total: 0,
    urls: [],
  });

  const res = await runCli(["discover", "https://example.com", "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(gw.requests[0]!.json, { url: "https://example.com" });
});

test("test_discover_text_mode_prints_urls_on_stdout_summary_on_stderr", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const urls = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
  gw.json("POST /v2/discover", 200, {
    url: "https://example.com",
    mode: "hybrid",
    total: 3,
    urls,
    truncated: false,
    sources: { sitemap: 3 },
    warnings: [],
  });

  const res = await runCli(["discover", "https://example.com"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  // stdout is EXACTLY the three URLs, one per line — pipeable.
  assert.equal(res.stdout, urls.join("\n") + "\n");
  assert.match(res.stderr, /discovered 3 URLs \(mode hybrid; sources: sitemap=3\)/);
});

test("test_discover_json_emits_raw_response", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  const response = {
    url: "https://example.com",
    mode: "sitemap",
    total: 1,
    urls: ["https://example.com/only"],
    pages_crawled: 0,
    truncated: false,
    robots_respected: false,
    sources: { sitemap: 1 },
    warnings: [],
  };
  gw.json("POST /v2/discover", 200, response);

  const res = await runCli(["discover", "https://example.com", "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), response);
  // Raw JSON mode: no URL lines outside the document.
  assert.equal(res.stdout.trimEnd().startsWith("{"), true);
});

// --- lookup -----------------------------------------------------------------

test("test_lookup_full_flags_golden_body_including_enrich", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/lookup", 200, { query: "best pdf api", category: "news", total: 0, results: [] });

  const home = scratchDir();
  const enrichSchema = { company: "the company name", price: "monthly price in USD" };
  const schemaPath = join(home, "s.json");
  writeFileSync(schemaPath, JSON.stringify(enrichSchema));

  const res = await runCli(
    [
      "lookup", "best pdf api",
      "--category", "news",
      "--country", "us",
      "--locale", "en",
      "--time-filter", "week",
      "--num-results", "20",
      "--page", "2",
      "--location", "X",
      "--no-autocorrect",
      "--perceive-top", "3",
      "--enrich-output", "markdown,links",
      "--enrich-concurrency", "2",
      "--enrich-schema-file", schemaPath,
      "--synthesize-answer",
      "--answer-prompt", "P",
      "--json",
    ],
    { env: envFor(gw), home },
  );

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  const req = gw.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v2/lookup");
  assert.deepEqual(req.json, {
    query: "best pdf api",
    category: "news",
    country: "us",
    locale: "en",
    time_filter: "week",
    num_results: 20,
    page: 2,
    location: "X",
    autocorrect: false,
    perceive_top: 3,
    enrich: {
      outputs: ["markdown", "links"],
      concurrency: 2,
      schema: enrichSchema,
      synthesize_answer: true,
      answer_prompt: "P",
    },
  });
});

test("test_lookup_without_enrich_flags_omits_enrich_key", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/lookup", 200, { query: "q", category: "web", total: 0, results: [] });

  const res = await runCli(["lookup", "q", "--num-results", "5", "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  const body = gw.requests[0]!.json as Record<string, unknown>;
  assert.deepEqual(body, { query: "q", num_results: 5 });
  assert.ok(!("enrich" in body), "enrich must be absent when no enrich flag is set");
});

test("test_lookup_answer_and_sources_rendered_in_text_mode", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/lookup", 200, {
    query: "q",
    category: "web",
    total: 2,
    results: [
      { position: 1, title: "First title", url: "https://a.com" },
      { position: 2, title: "Second title", url: "https://b.com" },
    ],
    answer: "The answer.",
    answer_sources: ["https://a.com", "https://b.com"],
    warnings: [],
  });

  const res = await runCli(["lookup", "q", "--perceive-top", "2", "--synthesize-answer"], {
    env: envFor(gw),
  });

  assert.equal(res.code, 0, res.stderr);
  // Answer first, then blank line, then citation-ordered sources.
  assert.ok(
    res.stdout.startsWith("The answer.\n\n[1] https://a.com\n[2] https://b.com\n\n"),
    `unexpected stdout:\n${res.stdout}`,
  );
  // Results table follows on stdout.
  assert.match(res.stdout, /First title/);
  assert.match(res.stdout, /https:\/\/b\.com/);
  assert.match(res.stderr, /2 results for "q" \(web\)/);
});

test("test_search_alias_posts_to_v2_lookup", async (t) => {
  const gw = await startMockGateway();
  t.after(() => gw.close());
  gw.json("POST /v2/lookup", 200, { query: "q", category: "web", total: 0, results: [] });

  const res = await runCli(["search", "q", "--json"], { env: envFor(gw) });

  assert.equal(res.code, 0, res.stderr);
  assert.equal(gw.requests.length, 1);
  assert.equal(gw.requests[0]!.path, "/v2/lookup");
  assert.deepEqual(gw.requests[0]!.json, { query: "q" });
});
