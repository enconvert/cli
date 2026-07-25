// The endpoint-coverage contract: every (method, path) in the bundled API
// index must be consciously mapped to a CLI surface — a typed command, the
// `api` passthrough (documented integration surfaces + 503 stubs + internal
// ops), or the deliberate watch exclusion. A new gateway endpoint fails this
// test until someone makes a conscious CLI decision; a removed endpoint fails
// it until the stale mapping is deleted. It also pins EXCLUDED_ROUTES and
// UPLOAD_ROUTES against the index so neither generated table can go stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_INDEX } from "../src/api/api-index.generated.js";
import { EXCLUDED_ROUTES, UPLOAD_ROUTES } from "../src/api/routes.generated.js";

/**
 * CLI surface for every endpoint. Keys are "METHOD /path" exactly as they
 * appear in API_INDEX. Values:
 *   - a typed command name (the first-class UX for that endpoint),
 *   - "api" for surfaces deliberately served ONLY by the `api` passthrough
 *     (auth token/refresh/branding, widget, extension, internal ops, the five
 *     503 converter stubs, and the version-index roots),
 *   - "excluded-watch" for the /v2/watch family (out of CLI scope; name reserved).
 */
const CLI_SURFACE: Record<string, string> = {
  // System / identity
  "GET /": "api",
  "GET /health": "status",
  "GET /v1/": "api",
  "GET /v2/": "api",
  "GET /v1/whoami": "whoami",
  "GET /v1/auth/verify": "auth",

  // Integration surfaces (documented as api-passthrough-only)
  "POST /v1/auth/token": "api",
  "POST /v1/auth/refresh": "api",
  "GET /v1/auth/branding": "api",
  "GET /v1/widget/{widget_id}/config": "api",
  "POST /v1/widget/{widget_id}/token": "api",
  "POST /v1/widget/{widget_id}/refresh": "api",
  "POST /v1/extension/capture": "api",
  "POST /internal/cleanup-file": "api",
  "POST /internal/rotate-usage-period": "api",

  // The five unimplemented 503 stubs (reachable, never typed)
  "POST /v1/convert/thumbnail": "api",
  "POST /v1/convert/video": "api",
  "POST /v1/convert/ocr": "api",
  "POST /v1/convert/speech-to-text": "api",
  "POST /v1/convert/text-to-speech": "api",

  // V1 upload conversions — `convert` (+ the data/pdf/markdown/compress aliases)
  "POST /v1/convert/json-to-xml": "convert",
  "POST /v1/convert/xml-to-json": "convert",
  "POST /v1/convert/json-to-yaml": "convert",
  "POST /v1/convert/yaml-to-json": "convert",
  "POST /v1/convert/csv-to-json": "convert",
  "POST /v1/convert/json-to-csv": "convert",
  "POST /v1/convert/json-to-toml": "convert",
  "POST /v1/convert/toml-to-json": "convert",
  "POST /v1/convert/csv-to-xml": "convert",
  "POST /v1/convert/xml-to-csv": "convert",
  "POST /v1/convert/markdown-to-html": "convert",
  "POST /v1/convert/html-to-pdf": "convert",
  "POST /v1/convert/markdown-to-pdf": "convert",
  "POST /v1/convert/doc-to-pdf": "convert",
  "POST /v1/convert/excel-to-pdf": "convert",
  "POST /v1/convert/ppt-to-pdf": "convert",
  "POST /v1/convert/odt-to-pdf": "convert",
  "POST /v1/convert/ods-to-pdf": "convert",
  "POST /v1/convert/odp-to-pdf": "convert",
  "POST /v1/convert/ots-to-pdf": "convert",
  "POST /v1/convert/pages-to-pdf": "convert",
  "POST /v1/convert/numbers-to-pdf": "convert",
  "POST /v1/convert/anything-to-markdown": "markdown",
  "POST /v1/convert/anything-to-pdf": "pdf",
  "POST /v1/convert/jpeg-to-png": "convert",
  "POST /v1/convert/png-to-jpeg": "convert",
  "POST /v1/convert/jpeg-to-svg": "convert",
  "POST /v1/convert/svg-to-jpeg": "convert",
  "POST /v1/convert/jpeg-to-heic": "convert",
  "POST /v1/convert/heic-to-jpeg": "convert",
  "POST /v1/convert/jpeg-to-webp": "convert",
  "POST /v1/convert/webp-to-jpeg": "convert",
  "POST /v1/convert/png-to-svg": "convert",
  "POST /v1/convert/svg-to-png": "convert",
  "POST /v1/convert/png-to-heic": "convert",
  "POST /v1/convert/heic-to-png": "convert",
  "POST /v1/convert/png-to-webp": "convert",
  "POST /v1/convert/webp-to-png": "convert",
  "POST /v1/convert/svg-to-heic": "convert",
  "POST /v1/convert/heic-to-svg": "convert",
  "POST /v1/convert/svg-to-webp": "convert",
  "POST /v1/convert/webp-to-svg": "convert",
  "POST /v1/convert/heic-to-webp": "convert",
  "POST /v1/convert/webp-to-heic": "convert",
  "POST /v1/convert/pdf-to-jpeg": "convert",
  "POST /v1/convert/compress-image": "compress",

  // V1 URL render + website crawl
  "POST /v1/convert/url-to-pdf": "url",
  "POST /v1/convert/url-to-screenshot": "url",
  "POST /v1/convert/url-to-markdown": "url",
  "POST /v1/convert/website-to-pdf": "site",
  "POST /v1/convert/website-to-screenshot": "site",

  // V1 polling & storage
  "GET /v1/convert/status/{job_id}": "jobs",
  "GET /v1/convert/batch/{batch_id}": "jobs",
  "GET /v1/convert/download/{object_key}": "files",

  // V2
  "POST /v2/perceive": "perceive",
  "GET /v2/perceive/{operation_id}": "perceive",
  "POST /v2/perceive/batch": "perceive",
  "GET /v2/perceive/batch/{job_id}": "perceive",
  "DELETE /v2/perceive/batch/{job_id}": "perceive",
  "POST /v2/discover": "discover",
  "POST /v2/lookup": "lookup",
  "POST /v2/distill": "distill",
  "POST /v2/ingest": "ingest",
  "GET /v2/ingest": "ingest",
  "POST /v2/ingest/files": "ingest",
  "GET /v2/ingest/{job_id}": "ingest",
  "DELETE /v2/ingest/{job_id}": "ingest",
  "POST /v2/ingest/{job_id}/retry-webhook": "ingest",
  "GET /v2/ingest/webhook-secret": "ingest",
  "POST /v2/ingest/webhook-secret/rotate": "ingest",

  // Watch family — deliberately out of CLI scope (the `watch` name is reserved)
  "GET /v2/watch": "excluded-watch",
  "POST /v2/watch": "excluded-watch",
  "GET /v2/watch/{watcher_id}": "excluded-watch",
  "PATCH /v2/watch/{watcher_id}": "excluded-watch",
  "DELETE /v2/watch/{watcher_id}": "excluded-watch",
  "GET /v2/watch/{watcher_id}/snapshots": "excluded-watch",
};

function keyOf(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

test("test_every_api_index_endpoint_has_an_explicit_cli_surface_mapping", () => {
  const unmapped = API_INDEX
    .map((e) => keyOf(e.method, e.path))
    .filter((k) => CLI_SURFACE[k] === undefined);
  assert.deepEqual(
    unmapped,
    [],
    "NEW gateway endpoint(s) reached the bundled API index without a CLI decision.\n" +
      "For each endpoint above, decide its surface and add it to CLI_SURFACE in this test:\n" +
      '  - a typed command name (and build/extend that command), or\n' +
      '  - "api" if the passthrough is the deliberate long-term surface, or\n' +
      '  - "excluded-watch"-style label for a deliberate exclusion (also add it to EXCLUDED_ROUTES).\n',
  );
});

test("test_no_mapped_endpoint_has_disappeared_from_the_api_index", () => {
  const indexKeys = new Set(API_INDEX.map((e) => keyOf(e.method, e.path)));
  const stale = Object.keys(CLI_SURFACE).filter((k) => !indexKeys.has(k));
  assert.deepEqual(
    stale,
    [],
    "Endpoint(s) mapped in CLI_SURFACE no longer exist in the API index.\n" +
      "The gateway removed or renamed them: update the typed command that fronted each one,\n" +
      "then delete the stale mapping(s) above from this test.\n",
  );
});

test("test_typed_surface_labels_are_from_the_known_command_vocabulary", () => {
  // Guards against typos in the map itself ("covnert" would silently pass the
  // completeness checks otherwise).
  const known = new Set([
    "api", "excluded-watch",
    "status", "whoami", "auth",
    "convert", "compress", "pdf", "markdown",
    "url", "site", "jobs", "files",
    "perceive", "discover", "lookup", "distill", "ingest",
  ]);
  const bogus = Object.entries(CLI_SURFACE).filter(([, surface]) => !known.has(surface));
  assert.deepEqual(bogus, [], "unknown surface label(s) in CLI_SURFACE");
});

test("test_every_excluded_route_still_exists_in_the_api_index", () => {
  const stale: string[] = [];
  for (const excluded of EXCLUDED_ROUTES) {
    const matches = API_INDEX.filter((e) => {
      const samePath =
        excluded.endpoint === "/v2/watch"
          ? e.path === "/v2/watch" || e.path.startsWith("/v2/watch/")
          : e.path === excluded.endpoint;
      const sameMethod = excluded.method === "*" || e.method.toUpperCase() === excluded.method.toUpperCase();
      return samePath && sameMethod;
    });
    if (matches.length === 0) stale.push(`${excluded.method} ${excluded.endpoint} (${excluded.reason})`);
  }
  assert.deepEqual(
    stale,
    [],
    "EXCLUDED_ROUTES lists endpoint(s) the gateway no longer serves — regenerate " +
      "the route tables (npm run gen:routes) and drop the stale exclusions.\n",
  );
});

test("test_excluded_routes_are_never_also_typed_commands", () => {
  // An endpoint cannot be both deliberately excluded and given a typed command.
  const typedConflicts: string[] = [];
  for (const excluded of EXCLUDED_ROUTES) {
    for (const [key, surface] of Object.entries(CLI_SURFACE)) {
      if (surface === "api" || surface === "excluded-watch") continue;
      const [, path] = key.split(" ") as [string, string];
      const covered =
        excluded.endpoint === "/v2/watch"
          ? path === "/v2/watch" || path.startsWith("/v2/watch/")
          : path === excluded.endpoint;
      if (covered) typedConflicts.push(`${key} -> ${surface} conflicts with exclusion ${excluded.endpoint}`);
    }
  }
  assert.deepEqual(typedConflicts, []);
});

test("test_every_upload_route_appears_in_the_api_index_as_post", () => {
  const indexPosts = new Set(
    API_INDEX.filter((e) => e.method.toUpperCase() === "POST").map((e) => e.path),
  );
  const missing = UPLOAD_ROUTES.filter((r) => !indexPosts.has(r.endpoint)).map((r) => r.endpoint);
  assert.deepEqual(
    missing,
    [],
    "UPLOAD_ROUTES contains endpoint(s) the API index does not serve as POST — " +
      "the (from, to) table and the index were generated from different gateways.\n",
  );
  // And each upload route is a first-class typed surface in the map above.
  const untyped = UPLOAD_ROUTES
    .map((r) => `POST ${r.endpoint}`)
    .filter((k) => {
      const surface = CLI_SURFACE[k];
      return surface === undefined || surface === "api" || surface === "excluded-watch";
    });
  assert.deepEqual(untyped, [], "every generated upload route must map to a typed command");
});
