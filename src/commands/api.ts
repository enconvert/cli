// enconvert api — the coverage guarantee. An authenticated passthrough to ANY
// gateway endpoint using gh api's flag vocabulary, so every endpoint in the
// bundled API index (and every future one) is callable with no CLI release.
//
// Flag-collision ruling (IMPLEMENTATION-PLAN.md): INSIDE this command -f/-F
// mean --raw-field/--field and -q/-t mean --jq/--template, shadowing the
// global -F/--force and -q/--quiet. Globals still work spelled out or placed
// before the subcommand name.
import { openAsBlob, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { API_INDEX, type ApiIndexEntry } from "../api/api-index.generated.js";
import { inputNotFoundError, statusToExitCode, usageError } from "../api/errors.js";
import { apiRequest, type ApiRequestOptions, type ApiResponse } from "../api/http.js";
import type { Context } from "../config/resolve.js";
import { evaluateJq, formatJqResults } from "../output/jq.js";
import { printJson } from "../output/json.js";
import { out, outBytes, verbose, warn } from "../output/streams.js";
import { renderTable } from "../output/table.js";
import { renderTemplate } from "../output/template.js";
import { collectRepeatable, contextFor } from "../program.js";
import { parseHeaderFlags } from "./_shared.js";

/** Hard cap so a server that always reports has_more cannot loop forever. */
const MAX_PAGES = 1000;

interface ApiOptions {
  method?: string;
  rawField: string[];
  field: string[];
  header: string[];
  input?: string;
  jq?: string;
  template?: string;
  include?: boolean;
  silent?: boolean;
  paginate?: boolean;
  slurp?: boolean;
  listEndpoints?: boolean;
  search?: string;
  describe?: string;
}

/** One bracket-path segment of a field key; null means "append to array" ([]). */
type KeySegment = string | null;

/** Field values stay symbolic until we know the body mode: @file must become a
 * Blob for multipart endpoints but a utf-8 string for JSON bodies. */
type FieldValue =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

interface ParsedField {
  /** The key exactly as typed; used verbatim for query params and form names. */
  rawKey: string;
  segments: KeySegment[];
  value: FieldValue;
}

function parseFieldKey(key: string): KeySegment[] {
  const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
  if (!match || match[1] === undefined) {
    throw usageError(`invalid field key "${key}" (expected name, name[sub], or name[])`);
  }
  const segments: KeySegment[] = [match[1]];
  for (const bracket of (match[2] ?? "").match(/\[[^[\]]*\]/g) ?? []) {
    const inner = bracket.slice(1, -1);
    segments.push(inner === "" ? null : inner);
  }
  return segments;
}

/** -F magic typing: JSON literals and integers convert, everything else is a string. */
function magicType(raw: string): string | number | boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  return raw;
}

function parseFieldFlag(raw: string, typed: boolean): ParsedField {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw usageError(`invalid field "${raw}" (expected key=value)`, {
      help: ["example: -f url=https://example.com  or  -F mobile=true"],
    });
  }
  const rawKey = raw.slice(0, eq);
  const rawValue = raw.slice(eq + 1);
  const segments = parseFieldKey(rawKey);
  if (!typed) {
    // -f/--raw-field: always a literal string, no @ processing (gh semantics).
    return { rawKey, segments, value: { kind: "literal", value: rawValue } };
  }
  if (rawValue === "@-") return { rawKey, segments, value: { kind: "stdin" } };
  if (rawValue.startsWith("@")) return { rawKey, segments, value: { kind: "file", path: rawValue.slice(1) } };
  return { rawKey, segments, value: { kind: "literal", value: magicType(rawValue) } };
}

function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw inputNotFoundError(`cannot read ${path}`, { cause: e });
  }
}

function resolveScalar(value: FieldValue, readStdin: () => string): string | number | boolean | null {
  switch (value.kind) {
    case "literal":
      return value.value;
    case "file":
      return readFileText(value.path);
    case "stdin":
      return readStdin();
  }
}

/** Build nested objects/arrays from k[sub]=v and k[]=v keys (gh semantics:
 * each [] appends a new element). */
function setNested(root: Record<string, unknown>, field: ParsedField, value: unknown): void {
  let container: Record<string, unknown> | unknown[] = root;
  const { segments, rawKey } = field;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? null;
    const last = i === segments.length - 1;
    const nextIsAppend = !last && segments[i + 1] === null;
    if (seg === null) {
      if (!Array.isArray(container)) {
        throw usageError(`field "${rawKey}" uses [] where an earlier field built an object`);
      }
      if (last) {
        container.push(value);
        return;
      }
      const child: Record<string, unknown> | unknown[] = nextIsAppend ? [] : {};
      container.push(child);
      container = child;
    } else {
      if (Array.isArray(container)) {
        throw usageError(`field "${rawKey}" uses a named key where an earlier field built an array`);
      }
      if (last) {
        container[seg] = value;
        return;
      }
      let child = container[seg];
      if (child === undefined) {
        child = nextIsAppend ? [] : {};
        container[seg] = child;
      }
      const childOk = nextIsAppend
        ? Array.isArray(child)
        : typeof child === "object" && child !== null && !Array.isArray(child);
      if (!childOk) {
        throw usageError(`field "${rawKey}" conflicts with an earlier field of a different shape`);
      }
      container = child as Record<string, unknown> | unknown[];
    }
  }
}

function splitPathQuery(rawPath: string): { pathname: string; query: URLSearchParams } {
  const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const qIndex = normalized.indexOf("?");
  if (qIndex === -1) return { pathname: normalized, query: new URLSearchParams() };
  return {
    pathname: normalized.slice(0, qIndex),
    query: new URLSearchParams(normalized.slice(qIndex + 1)),
  };
}

/** Segment-wise match of a concrete path against a templated index path, so
 * /v1/convert/status/abc finds /v1/convert/status/{job_id}. */
function templateMatches(templatePath: string, concretePath: string): boolean {
  if (templatePath === concretePath) return true;
  const t = templatePath.split("/").filter((s) => s !== "");
  const c = concretePath.split("/").filter((s) => s !== "");
  if (t.length !== c.length) return false;
  return t.every((seg, i) => (seg.startsWith("{") && seg.endsWith("}")) || seg === c[i]);
}

/** Exact path matches win over templated ones (/v2/ingest/webhook-secret must
 * not be swallowed by /v2/ingest/{job_id}). */
function entriesForPath(concretePath: string): ApiIndexEntry[] {
  const exact = API_INDEX.filter((e) => e.path === concretePath);
  if (exact.length > 0) return exact;
  return API_INDEX.filter((e) => templateMatches(e.path, concretePath));
}

function findEntry(method: string, concretePath: string): ApiIndexEntry | undefined {
  return entriesForPath(concretePath).find((e) => e.method === method);
}

async function openAsBlobChecked(path: string): Promise<Blob> {
  try {
    return await openAsBlob(path);
  } catch (e) {
    throw inputNotFoundError(`cannot read ${path}`, { cause: e });
  }
}

async function buildMultipartForm(fields: ParsedField[], readStdin: () => string): Promise<FormData> {
  const form = new FormData();
  for (const field of fields) {
    if (field.value.kind === "file") {
      const blob = await openAsBlobChecked(field.value.path);
      form.append(field.rawKey, blob, basename(field.value.path));
    } else if (field.value.kind === "stdin") {
      form.append(field.rawKey, new Blob([readStdin()]), "stdin");
    } else {
      form.append(field.rawKey, String(field.value.value));
    }
  }
  return form;
}

/** Advance skip/limit pagination; null means "stop". The page-array key varies
 * per endpoint (jobs, watchers, ...) so any array-valued property counts. */
function nextSkipFrom(payload: unknown, currentSkip: number): number | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record["has_more"] !== true) return null;
  const skip = typeof record["skip"] === "number" ? record["skip"] : currentSkip;
  const limit = typeof record["limit"] === "number" ? record["limit"] : 20;
  const pageArray = Object.values(record).find((v): v is unknown[] => Array.isArray(v));
  const pageLength = pageArray !== undefined ? pageArray.length : limit;
  if (pageLength <= 0) return null; // defensive: an empty page with has_more would loop forever
  return skip + pageLength;
}

function emitJsonPayload(payload: unknown, jqExpr: string | undefined, template: string | undefined): void {
  if (jqExpr !== undefined) {
    out(formatJqResults(evaluateJq(jqExpr, payload)));
  } else if (template !== undefined) {
    process.stdout.write(renderTemplate(template, payload));
  } else {
    printJson(payload);
  }
}

function describeEntry(entry: ApiIndexEntry): string {
  const title = entry.summary !== "" ? `${entry.method} ${entry.path} — ${entry.summary}` : `${entry.method} ${entry.path}`;
  const lines = [title];
  if (entry.tags.length > 0) lines.push(`  tags:        ${entry.tags.join(", ")}`);
  if (entry.params.length > 0) lines.push(`  params:      ${entry.params.join(", ")}`);
  if (entry.bodyContentType !== undefined) {
    lines.push(`  body:        ${entry.bodyContentType}`);
    if (entry.bodyFields !== undefined && entry.bodyFields.length > 0) {
      lines.push(`  body fields: ${entry.bodyFields.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** --list-endpoints / --search / --describe: offline, no auth needed. */
function runOffline(ctx: Context, opts: ApiOptions): void {
  let entries: ApiIndexEntry[];
  if (opts.listEndpoints === true) {
    entries = API_INDEX;
  } else if (opts.search !== undefined) {
    const q = opts.search.toLowerCase();
    entries = API_INDEX.filter(
      (e) =>
        e.path.toLowerCase().includes(q) ||
        e.summary.toLowerCase().includes(q) ||
        e.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  } else {
    const target = opts.describe ?? "";
    const { pathname } = splitPathQuery(target);
    entries = entriesForPath(pathname);
    if (entries.length === 0) {
      throw usageError(`no endpoint matches ${target}`, {
        help: ["run `enconvert api --list-endpoints` to see every endpoint", "or `enconvert api --search <q>`"],
      });
    }
  }

  const jqExpr = opts.jq ?? ctx.opts.jq;
  const template = opts.template ?? ctx.opts.template;
  if (jqExpr !== undefined || template !== undefined || ctx.opts.json === true) {
    emitJsonPayload(entries, jqExpr, template);
    return;
  }
  if (opts.describe !== undefined) {
    out(entries.map(describeEntry).join("\n\n"));
    return;
  }
  if (entries.length === 0) {
    warn(`no endpoints match "${opts.search ?? ""}"`);
    return;
  }
  out(renderTable(entries.map((e) => [e.method, e.path, e.summary]), { header: ["METHOD", "PATH", "SUMMARY"] }));
}

async function runApi(ctx: Context, pathArg: string | undefined, opts: ApiOptions): Promise<void> {
  const offlineModes = [opts.listEndpoints === true, opts.search !== undefined, opts.describe !== undefined];
  if (offlineModes.filter(Boolean).length > 1) {
    throw usageError("choose one of --list-endpoints, --search, --describe");
  }
  if (offlineModes.some(Boolean)) {
    runOffline(ctx, opts);
    return;
  }

  if (pathArg === undefined || pathArg.trim() === "") {
    throw usageError("missing <path> (e.g. /v1/whoami)", {
      help: ["run `enconvert api --list-endpoints` to see every endpoint"],
    });
  }

  const fields: ParsedField[] = [
    ...opts.rawField.map((raw) => parseFieldFlag(raw, false)),
    ...opts.field.map((raw) => parseFieldFlag(raw, true)),
  ];

  const hasBodyInputs = fields.length > 0 || opts.input !== undefined;
  const method = (opts.method ?? (hasBodyInputs ? "POST" : "GET")).toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw usageError(`invalid HTTP method "${opts.method ?? ""}"`);
  }
  if (opts.slurp === true && opts.paginate !== true) {
    throw usageError("--slurp requires --paginate");
  }
  if (opts.paginate === true && method !== "GET") {
    throw usageError("--paginate only supports GET requests (skip/limit pagination)");
  }
  if (opts.input !== undefined && (method === "GET" || method === "HEAD")) {
    throw usageError(`--input needs a body-accepting method, not ${method}`, {
      help: ["drop -X (POST is the default with --input), or pass -X POST/PUT/PATCH"],
    });
  }

  const headers = parseHeaderFlags(opts.header);
  const { pathname, query } = splitPathQuery(pathArg.trim());

  // Read stdin at most once even when several values reference @-.
  let stdinText: string | undefined;
  const readStdin = (): string => {
    stdinText ??= readFileSync(0, "utf8");
    return stdinText;
  };

  let jsonBody: unknown;
  let form: FormData | undefined;
  if (opts.input !== undefined) {
    const text = opts.input === "-" ? readStdin() : readFileText(opts.input);
    try {
      jsonBody = JSON.parse(text) as unknown;
    } catch {
      throw usageError(`--input ${opts.input} is not valid JSON`);
    }
  }

  // With --input, or on GET/HEAD, field flags become query parameters
  // (gh semantics). Otherwise they form the request body.
  if (opts.input !== undefined || method === "GET" || method === "HEAD") {
    for (const field of fields) {
      query.append(field.rawKey, String(resolveScalar(field.value, readStdin)));
    }
  } else if (fields.length > 0) {
    const entry = findEntry(method, pathname);
    if (entry?.bodyContentType === "multipart/form-data") {
      verbose(`${method} ${entry.path} expects multipart/form-data; building a form upload`);
      form = await buildMultipartForm(fields, readStdin);
    } else {
      const body: Record<string, unknown> = {};
      for (const field of fields) {
        setNested(body, field, resolveScalar(field.value, readStdin));
      }
      jsonBody = body;
    }
  }

  // Send anonymously when no credential exists at all, so keyless endpoints
  // (e.g. /health) work and everything else surfaces the gateway's own 401.
  const anonymous = ctx.tryApiKey() === undefined;

  const requestOnce = async (): Promise<ApiResponse> => {
    const qs = query.toString();
    const requestOpts: ApiRequestOptions = {
      method,
      path: qs === "" ? pathname : `${pathname}?${qs}`,
      headers,
      allowErrorResponse: true,
    };
    if (jsonBody !== undefined) requestOpts.jsonBody = jsonBody;
    if (form !== undefined) requestOpts.form = form;
    if (anonymous) requestOpts.anonymous = true;
    return apiRequest(ctx, requestOpts);
  };

  const jqExpr = opts.jq ?? ctx.opts.jq;
  const template = opts.template ?? ctx.opts.template;

  const printHead = (res: ApiResponse): void => {
    if (opts.include !== true) return;
    out(`HTTP/${res.status}`);
    res.headers.forEach((value, name) => out(`${name}: ${value}`));
    out("");
  };

  const printBody = (res: ApiResponse): void => {
    if (opts.silent === true) return;
    if (res.json !== undefined) {
      emitJsonPayload(res.json, jqExpr, template);
      return;
    }
    if (res.bytes !== undefined && res.bytes.length > 0) {
      if (jqExpr !== undefined || template !== undefined) {
        warn("response is not JSON; --jq/--template ignored");
      }
      outBytes(res.bytes);
    }
  };

  if (opts.paginate !== true) {
    const res = await requestOnce();
    printHead(res);
    printBody(res);
    if (res.status >= 400) process.exitCode = statusToExitCode(res.status);
    return;
  }

  // --paginate: follow skip/limit pagination while the response reports has_more.
  const pages: unknown[] = [];
  let skip = Number(query.get("skip") ?? "0");
  if (!Number.isFinite(skip)) skip = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) query.set("skip", String(skip));
    const res = await requestOnce();
    printHead(res);
    if (res.status >= 400) {
      printBody(res);
      process.exitCode = statusToExitCode(res.status);
      break;
    }
    if (res.json === undefined) {
      printBody(res);
      break;
    }
    if (opts.slurp === true) pages.push(res.json);
    else printBody(res);
    const next = nextSkipFrom(res.json, skip);
    if (next === null) break;
    skip = next;
    if (page === MAX_PAGES - 1) {
      warn(`stopped after ${MAX_PAGES} pages; the endpoint still reports has_more`);
    }
  }
  if (opts.slurp === true && pages.length > 0 && opts.silent !== true) {
    emitJsonPayload(pages, jqExpr, template);
  }
}

export function registerApiCommand(program: Command): void {
  program
    .command("api")
    .description("Send an authenticated request to any Enconvert gateway endpoint")
    .argument("[path]", "endpoint path, e.g. /v1/whoami (fill templated segments with real values)")
    .option("-X, --method <method>", "HTTP method (default GET; auto-POST when a field flag or --input is present)")
    .option("-f, --raw-field <key=value>", "string field; repeatable (shadows the global -F/--force here)", collectRepeatable, [] as string[])
    .option(
      "-F, --field <key=value>",
      "typed field: true/false/null and integers become JSON, @file reads a file, @- reads stdin; k[sub]=v nests, k[]=v appends; repeatable",
      collectRepeatable,
      [] as string[],
    )
    .option("-H, --header <header>", "request header 'Name: value'; repeatable", collectRepeatable, [] as string[])
    .option("--input <file>", "JSON request body from a file, or - for stdin (field flags then become query parameters)")
    .option("-q, --jq <expr>", "filter the JSON response (shadows the global -q/--quiet here)")
    .option("-t, --template <tmpl>", "format the JSON response with a template (shadows the global --template)")
    .option("-i, --include", "print the HTTP status and response headers before the body")
    .option("--silent", "do not print the response body")
    .option("--paginate", "follow skip/limit pagination while the response reports has_more (GET only)")
    .option("--slurp", "with --paginate, wrap all pages in one JSON array")
    .option("--list-endpoints", "list every gateway endpoint from the bundled API index (offline)")
    .option("--search <query>", "search endpoints by path, summary, or tag (offline)")
    .option("--describe <path>", "show an endpoint's methods, params, and body fields (offline)")
    .addHelpText(
      "after",
      `
Every gateway endpoint is reachable here, including surfaces without a typed
command (auth token exchange, widget config, extension capture). New gateway
endpoints work the day they ship with no CLI update.

Flag exceptions inside this command (gh api vocabulary):
  -f/-F mean --raw-field/--field and shadow the global -F/--force;
  -q means --jq and -t means --template, shadowing -q/--quiet. Place global
  flags before the subcommand name (enconvert --quiet api ...) to use them.

Bodies:
  GET requests (and any request with --input) send field flags as query
  parameters. Other methods send fields as a JSON body, or as a multipart
  upload when the endpoint expects one (detected from the bundled API index),
  in which case -F key=@file uploads the file itself.

Pagination:
  --paginate currently applies to skip/limit endpoints (responses carrying
  skip, limit, and has_more, e.g. GET /v2/ingest); it re-requests with an
  increasing skip until has_more is false.

Examples:
  enconvert api /v1/whoami --jq .plan_slug
  enconvert api /v2/perceive -f url=https://example.com -F mobile=true
  enconvert api /v2/ingest --input body.json
  enconvert api /v1/convert/anything-to-pdf -F file=@report.docx -f direct_download=false
  enconvert api /v2/ingest --paginate --slurp
  enconvert api /v1/convert/status/job_0123456789abcdef -i
  enconvert api --list-endpoints
  enconvert api --search perceive
  enconvert api --describe /v2/distill
`,
    )
    .action(async (pathArg: string | undefined, opts: ApiOptions, command: Command) => {
      const ctx = contextFor(command);
      await runApi(ctx, pathArg, opts);
    });
}
