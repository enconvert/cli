// Generates src/api/routes.generated.ts and src/api/api-index.generated.ts
// (+ api-index.generated.json) from the gateway's OpenAPI schema.
//
//   npm run gen:routes                       # fetch from ENCONVERT_API_URL (default production)
//   npm run gen:routes -- --openapi file.json
//
// The (from, to) matrix and capability flags are seeded here (they come from
// CONVERTER_MAP / ALLOWED_EXTENSIONS / dispatch modules, which OpenAPI does not
// expose) and cross-checked against the OpenAPI paths: a seeded route missing
// from OpenAPI fails the build; an unseeded /v1/convert POST route warns so a
// new format pair becomes a regenerated table, not new CLI code.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface SeedUpload {
  endpoint: string;
  name: string;
  group: "data" | "weasyprint" | "libreoffice" | "universal" | "image" | "compression";
  from: string[];
  to: string;
  serverAllowlist: boolean;
  pdfOptions: "full" | "grayscale-only" | null;
  widthHeight: boolean;
  targetSizeKb: boolean;
  note?: string;
}

const A2MD = [".csv", ".doc", ".docx", ".epub", ".htm", ".html", ".markdown", ".md", ".mdown", ".mkd", ".odp", ".ods", ".odt", ".pdf", ".ppt", ".pptx", ".rtf", ".text", ".txt", ".xhtml", ".xls", ".xlsx"];
const A2PDF = [".bmp", ".csv", ".doc", ".docx", ".epub", ".gif", ".heic", ".heif", ".htm", ".html", ".jpeg", ".jpg", ".markdown", ".md", ".mdown", ".mkd", ".numbers", ".odp", ".ods", ".odt", ".ots", ".pages", ".pdf", ".png", ".ppt", ".pptx", ".rtf", ".svg", ".text", ".tif", ".tiff", ".txt", ".webp", ".xhtml", ".xls", ".xlsx"];

function upload(name: string, group: SeedUpload["group"], from: string[], to: string, opts: Partial<SeedUpload> = {}): SeedUpload {
  return {
    endpoint: `/v1/convert/${name}`,
    name,
    group,
    from,
    to,
    serverAllowlist: opts.serverAllowlist ?? true,
    pdfOptions: opts.pdfOptions ?? null,
    widthHeight: opts.widthHeight ?? false,
    targetSizeKb: opts.targetSizeKb ?? false,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  };
}

const SEED_UPLOADS: SeedUpload[] = [
  // Data (11)
  upload("json-to-xml", "data", [".json"], "xml"),
  upload("xml-to-json", "data", [".xml"], "json"),
  upload("json-to-yaml", "data", [".json"], "yaml"),
  upload("yaml-to-json", "data", [".yaml", ".yml"], "json"),
  upload("csv-to-json", "data", [".csv"], "json"),
  upload("json-to-csv", "data", [".json"], "csv"),
  upload("json-to-toml", "data", [".json"], "toml"),
  upload("toml-to-json", "data", [".toml"], "json"),
  upload("csv-to-xml", "data", [".csv"], "xml"),
  upload("xml-to-csv", "data", [".xml"], "csv"),
  upload("markdown-to-html", "data", [".md", ".markdown"], "html"),
  // WeasyPrint (2)
  upload("html-to-pdf", "weasyprint", [".html", ".htm"], "pdf", { pdfOptions: "full" }),
  upload("markdown-to-pdf", "weasyprint", [".md", ".markdown"], "pdf", { pdfOptions: "full" }),
  // LibreOffice (9) — pdf_options grayscale only; explicit geometry -> 400
  upload("doc-to-pdf", "libreoffice", [".docx", ".doc"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("excel-to-pdf", "libreoffice", [".xlsx", ".xls"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("ppt-to-pdf", "libreoffice", [".ppt", ".pptx"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("odt-to-pdf", "libreoffice", [".odt"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("ods-to-pdf", "libreoffice", [".ods"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("odp-to-pdf", "libreoffice", [".odp"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("ots-to-pdf", "libreoffice", [".ots"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("pages-to-pdf", "libreoffice", [".pages"], "pdf", { pdfOptions: "grayscale-only" }),
  upload("numbers-to-pdf", "libreoffice", [".numbers"], "pdf", { pdfOptions: "grayscale-only" }),
  // Universal (2)
  upload("anything-to-markdown", "universal", A2MD, "md"),
  upload("anything-to-pdf", "universal", A2PDF, "pdf", {
    pdfOptions: "full",
    note: "geometry honored only for html/markdown/text/epub/image/svg inputs; office and .pdf inputs are grayscale-only",
  }),
  // Image (21)
  upload("jpeg-to-png", "image", [".jpeg", ".jpg"], "png"),
  upload("png-to-jpeg", "image", [".png"], "jpeg"),
  upload("jpeg-to-svg", "image", [".jpeg", ".jpg"], "svg", {
    serverAllowlist: false,
    note: "ALLOWED_EXTENSIONS has a misnamed jpg-to-svg key; magic-byte check still applies",
  }),
  upload("svg-to-jpeg", "image", [".svg"], "jpeg", { widthHeight: true }),
  upload("jpeg-to-heic", "image", [".jpeg", ".jpg"], "heic", { serverAllowlist: false }),
  upload("heic-to-jpeg", "image", [".heic", ".heif"], "jpeg", { serverAllowlist: false }),
  upload("jpeg-to-webp", "image", [".jpeg", ".jpg"], "webp", { serverAllowlist: false }),
  upload("webp-to-jpeg", "image", [".webp"], "jpeg", { serverAllowlist: false }),
  upload("png-to-svg", "image", [".png"], "svg", { serverAllowlist: false }),
  upload("svg-to-png", "image", [".svg"], "png", { widthHeight: true }),
  upload("png-to-heic", "image", [".png"], "heic", { serverAllowlist: false }),
  upload("heic-to-png", "image", [".heic", ".heif"], "png", { serverAllowlist: false }),
  upload("png-to-webp", "image", [".png"], "webp", { serverAllowlist: false }),
  upload("webp-to-png", "image", [".webp"], "png", { serverAllowlist: false }),
  upload("svg-to-heic", "image", [".svg"], "heic", { serverAllowlist: false }),
  upload("heic-to-svg", "image", [".heic", ".heif"], "svg", { serverAllowlist: false }),
  upload("svg-to-webp", "image", [".svg"], "webp", { widthHeight: true }),
  upload("webp-to-svg", "image", [".webp"], "svg", { serverAllowlist: false }),
  upload("heic-to-webp", "image", [".heic", ".heif"], "webp", { serverAllowlist: false }),
  upload("webp-to-heic", "image", [".webp"], "heic", { serverAllowlist: false }),
  upload("pdf-to-jpeg", "image", [".pdf"], "jpeg", {
    serverAllowlist: false,
    note: "multi-page PDFs return a ZIP (output sniffed via PK magic)",
  }),
  // Compression (1)
  upload("compress-image", "compression", [".png", ".jpg", ".jpeg", ".webp"], "same-as-input", {
    targetSizeKb: true,
    note: "output extension = input extension; target_size_kb must be >= 1",
  }),
];

/** Routes that exist in OpenAPI but must never resolve from `convert`/`formats`. */
const EXCLUDED: Array<{ endpoint: string; method: string; reason: string }> = [
  { endpoint: "/v1/convert/thumbnail", method: "post", reason: "unimplemented (503 stub)" },
  { endpoint: "/v1/convert/video", method: "post", reason: "unimplemented (503 stub)" },
  { endpoint: "/v1/convert/ocr", method: "post", reason: "unimplemented (503 stub)" },
  { endpoint: "/v1/convert/speech-to-text", method: "post", reason: "unimplemented (503 stub)" },
  { endpoint: "/v1/convert/text-to-speech", method: "post", reason: "unimplemented (503 stub)" },
  { endpoint: "/v1/auth/token", method: "post", reason: "browser/widget integration surface" },
  { endpoint: "/v1/auth/refresh", method: "post", reason: "browser cookie flow" },
  { endpoint: "/v1/auth/branding", method: "get", reason: "widget branding for pk_ keys" },
  { endpoint: "/v1/widget/{widget_id}/config", method: "get", reason: "widget embed surface" },
  { endpoint: "/v1/widget/{widget_id}/token", method: "post", reason: "widget embed surface" },
  { endpoint: "/v1/widget/{widget_id}/refresh", method: "post", reason: "widget embed surface" },
  { endpoint: "/v1/extension/capture", method: "post", reason: "browser-extension surface" },
  { endpoint: "/internal/cleanup-file", method: "post", reason: "internal ops (X-Internal-Auth)" },
  { endpoint: "/internal/rotate-usage-period", method: "post", reason: "internal ops (X-Internal-Auth)" },
  { endpoint: "/v2/watch", method: "*", reason: "out of CLI scope; `watch` name reserved" },
];

interface OpenApiDoc {
  paths: Record<string, Record<string, { summary?: string; tags?: string[]; parameters?: Array<{ name: string; in: string }>; requestBody?: { content?: Record<string, { schema?: unknown }> } }>>;
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
}

function resolveBodyFields(doc: OpenApiDoc, schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const s = schema as Record<string, unknown>;
  if (typeof s["$ref"] === "string") {
    const name = (s["$ref"] as string).split("/").pop() ?? "";
    const resolved = doc.components?.schemas?.[name];
    return resolved?.properties !== undefined ? Object.keys(resolved.properties) : [];
  }
  if (typeof s["properties"] === "object" && s["properties"] !== null) {
    return Object.keys(s["properties"] as object);
  }
  return [];
}

async function loadOpenApi(): Promise<OpenApiDoc> {
  const argIdx = process.argv.indexOf("--openapi");
  if (argIdx !== -1 && process.argv[argIdx + 1] !== undefined) {
    return JSON.parse(readFileSync(process.argv[argIdx + 1]!, "utf8")) as OpenApiDoc;
  }
  const base = (process.env["ENCONVERT_API_URL"] ?? "https://api.enconvert.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${base}/openapi.json -> HTTP ${res.status}`);
  return (await res.json()) as OpenApiDoc;
}

const HEADER = `// GENERATED by scripts/generate-routes.ts — do not edit by hand.
// Regenerate with: npm run gen:routes
`;

async function main(): Promise<void> {
  const doc = await loadOpenApi();
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  // --- Cross-check the seed against OpenAPI ---------------------------------
  const openapiPaths = new Set(Object.keys(doc.paths));
  const problems: string[] = [];
  for (const route of SEED_UPLOADS) {
    if (!openapiPaths.has(route.endpoint)) problems.push(`seeded route missing from OpenAPI: ${route.endpoint}`);
  }
  const seededNames = new Set(SEED_UPLOADS.map((r) => r.endpoint));
  const excludedSet = new Set(EXCLUDED.map((e) => e.endpoint));
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (!path.startsWith("/v1/convert/") || !("post" in methods)) continue;
    if (path.includes("{")) continue; // status/batch/download param routes
    if (path.startsWith("/v1/convert/url-to-") || path.startsWith("/v1/convert/website-to-")) continue;
    if (!seededNames.has(path) && !excludedSet.has(path)) {
      console.warn(`WARN: new unseeded upload route in OpenAPI: ${path} — add it to SEED_UPLOADS`);
    }
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }

  // --- routes.generated.ts ---------------------------------------------------
  const routesTs = `${HEADER}
export interface UploadRoute {
  endpoint: string;
  name: string;
  group: "data" | "weasyprint" | "libreoffice" | "universal" | "image" | "compression";
  /** Accepted input extensions (with dot), conservative client-side. */
  from: string[];
  /** Output format; "same-as-input" for compress-image. */
  to: string;
  /** Whether the gateway enforces its own extension allowlist. */
  serverAllowlist: boolean;
  pdfOptions: "full" | "grayscale-only" | null;
  widthHeight: boolean;
  targetSizeKb: boolean;
  note?: string;
}

export const UPLOAD_ROUTES: UploadRoute[] = ${JSON.stringify(SEED_UPLOADS, null, 2)};

export const EXCLUDED_ROUTES: Array<{ endpoint: string; method: string; reason: string }> = ${JSON.stringify(EXCLUDED, null, 2)};
`;
  writeFileSync(join(root, "src", "api", "routes.generated.ts"), routesTs);

  // --- api-index -------------------------------------------------------------
  interface IndexEntry {
    method: string;
    path: string;
    summary: string;
    tags: string[];
    params: string[];
    bodyContentType?: string;
    bodyFields?: string[];
  }
  const index: IndexEntry[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const entry: IndexEntry = {
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        tags: op.tags ?? [],
        params: (op.parameters ?? []).map((p) => p.name),
      };
      const content = op.requestBody?.content;
      if (content !== undefined) {
        const ct = Object.keys(content)[0];
        if (ct !== undefined) {
          entry.bodyContentType = ct;
          entry.bodyFields = resolveBodyFields(doc, content[ct]?.schema);
        }
      }
      index.push(entry);
    }
  }
  index.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

  const indexTs = `${HEADER}
export interface ApiIndexEntry {
  method: string;
  path: string;
  summary: string;
  tags: string[];
  params: string[];
  bodyContentType?: string;
  bodyFields?: string[];
}

export const API_INDEX: ApiIndexEntry[] = ${JSON.stringify(index, null, 2)};
`;
  writeFileSync(join(root, "src", "api", "api-index.generated.ts"), indexTs);
  writeFileSync(join(root, "src", "api", "api-index.generated.json"), JSON.stringify(index, null, 2) + "\n");

  console.log(`routes.generated.ts: ${SEED_UPLOADS.length} upload routes, ${EXCLUDED.length} exclusions`);
  console.log(`api-index.generated: ${index.length} endpoints`);
}

await main();
