// enconvert perceive — the /v2/perceive family (sync render, get, batch).
// Request fields are transcribed 1:1 from the gateway's PerceiveRequest /
// PerceiveBatchRequest schemas; only values the user explicitly set are sent so
// server-side defaults stay in charge. proxy_url / geolocation / action_chain
// are deliberately NOT exposed — the gateway always rejects them with 422.
import { readFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { downloadToFile, downloadToStdout } from "../api/download.js";
import { EXIT, inputNotFoundError, usageError } from "../api/errors.js";
import * as v2 from "../api/v2.js";
import type { Context } from "../config/resolve.js";
import { printJson, printJsonl } from "../output/json.js";
import { info, out, outBytes, warn } from "../output/streams.js";
import { addWaitOptions, collectRepeatable, contextFor } from "../program.js";
import { atomicWriteFile } from "../util/files.js";
import { waitForPerceiveBatch } from "../util/poll.js";
import {
  csvList,
  emitJson,
  parseBasicAuth,
  parseCookieFlags,
  parseHeaderFlags,
  requireHttpUrl,
  resolveArtifactPath,
  waitOptionsFrom,
} from "./_shared.js";

const OUTPUT_NAMES = [
  "markdown",
  "html_cleaned",
  "html_raw",
  "screenshot",
  "screenshot_full_page",
  "pdf",
  "links",
  "images",
  "structured",
] as const;

const EXTRACT_NAMES = [
  "tables",
  "prices",
  "contacts",
  "metadata",
  "main_content",
  "headings",
  "structured_data",
  "technologies",
  "all",
] as const;

const RESOURCE_TYPES = [
  "image",
  "media",
  "font",
  "stylesheet",
  "script",
  "xhr",
  "fetch",
  "websocket",
  "manifest",
  "other",
] as const;

interface PerceiveOptionFlags {
  output?: string;
  extract?: string;
  schemaFile?: string;
  waitFor?: string;
  waitTimeoutMs?: string;
  jsCode?: string;
  viewport?: string;
  mobile?: boolean;
  respectRobots?: boolean;
  fullPage?: boolean;
  cacheMode?: string;
  blockResource?: string;
  header: string[];
  cookie: string[];
  basicAuth?: string;
  pdfPageSize?: string;
  pdfOrientation?: string;
  pdfMargin?: string;
  pdfScale?: string;
  pdfGrayscale?: boolean;
  pdfHeader?: string;
  pdfFooter?: string;
  pdfHeaderHeight?: string;
  pdfFooterHeight?: string;
  pdfPageWidth?: string;
  pdfPageHeight?: string;
}

interface PerceiveCmdOpts extends PerceiveOptionFlags {
  outputDir?: string;
  outputFile?: string;
  urlOnly?: boolean;
  directDownload?: boolean;
}

interface BatchCmdOpts extends PerceiveOptionFlags {
  inputFile?: string;
  outputMode?: string;
  outputFile?: string;
  outputDir?: string;
  wait?: boolean;
  pollInterval?: number;
  waitTimeout?: string;
  exitStatus?: boolean;
  urlOnly?: boolean;
}

function validatedList(raw: string, allowed: readonly string[], flag: string): string[] {
  const items = csvList(raw);
  if (items.length === 0) throw usageError(`${flag} needs at least one value`);
  for (const item of items) {
    if (!allowed.includes(item)) {
      throw usageError(`invalid ${flag} value "${item}"`, {
        help: [`valid values: ${allowed.join(", ")}`],
      });
    }
  }
  return items;
}

function intFlag(raw: string, flag: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`${flag} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function positiveFloat(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw usageError(`${flag} must be a positive number (got "${raw}")`);
  return n;
}

function readJsonObject(path: string, flag: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw inputNotFoundError(`cannot read ${flag} file: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw usageError(`${flag}: ${path} is not valid JSON`, {
      details: [e instanceof Error ? e.message : String(e)],
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`${flag}: ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** --js-code accepts inline source or @file. */
function readInlineOrFile(raw: string, flag: string): string {
  if (!raw.startsWith("@")) return raw;
  const path = raw.slice(1);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw inputNotFoundError(`cannot read ${flag} file: ${path}`);
  }
}

function parseViewport(raw: string): { width: number; height: number } {
  const m = /^(\d{2,4})[xX](\d{2,4})$/.exec(raw.trim());
  if (!m) throw usageError(`invalid --viewport "${raw}" (expected WIDTHxHEIGHT, e.g. 1440x900)`);
  const width = Number(m[1]!);
  const height = Number(m[2]!);
  if (width < 320 || width > 3840) throw usageError(`--viewport width must be 320-3840 (got ${width})`);
  if (height < 240 || height > 2160) throw usageError(`--viewport height must be 240-2160 (got ${height})`);
  return { width, height };
}

function parseMargins(raw: string): Record<string, number> {
  const nums = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => {
      const n = Number(p);
      if (!Number.isFinite(n) || n < 0) {
        throw usageError(`invalid --pdf-margin value "${p}" (margins are non-negative mm)`);
      }
      return n;
    });
  if (nums.length === 1) {
    const v = nums[0]!;
    return { top: v, right: v, bottom: v, left: v };
  }
  if (nums.length !== 4) {
    throw usageError("--pdf-margin takes one value for all sides, or four: top,right,bottom,left");
  }
  return { top: nums[0]!, right: nums[1]!, bottom: nums[2]!, left: nums[3]! };
}

function buildPdfOptions(o: PerceiveOptionFlags): Record<string, unknown> | undefined {
  const pdf: Record<string, unknown> = {};
  if (o.pdfPageSize !== undefined) pdf["page_size"] = o.pdfPageSize;
  if (o.pdfPageWidth !== undefined) pdf["page_width"] = positiveFloat(o.pdfPageWidth, "--pdf-page-width");
  if (o.pdfPageHeight !== undefined) pdf["page_height"] = positiveFloat(o.pdfPageHeight, "--pdf-page-height");
  if (o.pdfOrientation !== undefined) pdf["orientation"] = o.pdfOrientation;
  if (o.pdfMargin !== undefined) pdf["margins"] = parseMargins(o.pdfMargin);
  if (o.pdfScale !== undefined) {
    const scale = Number(o.pdfScale);
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 2.0) {
      throw usageError(`--pdf-scale must be between 0.1 and 2.0 (got "${o.pdfScale}")`);
    }
    pdf["scale"] = scale;
  }
  if (o.pdfGrayscale === true) pdf["grayscale"] = true;
  if (o.pdfHeader !== undefined || o.pdfHeaderHeight !== undefined) {
    if (o.pdfHeader === undefined) throw usageError("--pdf-header-height needs --pdf-header <html>");
    const header: Record<string, unknown> = { content: o.pdfHeader };
    if (o.pdfHeaderHeight !== undefined) header["height"] = positiveFloat(o.pdfHeaderHeight, "--pdf-header-height");
    pdf["header"] = header;
  }
  if (o.pdfFooter !== undefined || o.pdfFooterHeight !== undefined) {
    if (o.pdfFooter === undefined) throw usageError("--pdf-footer-height needs --pdf-footer <html>");
    const footer: Record<string, unknown> = { content: o.pdfFooter };
    if (o.pdfFooterHeight !== undefined) footer["height"] = positiveFloat(o.pdfFooterHeight, "--pdf-footer-height");
    pdf["footer"] = footer;
  }
  return Object.keys(pdf).length > 0 ? pdf : undefined;
}

/** Shared render/extract flags for `perceive <url>` and `perceive batch`. */
function addPerceiveOptions(cmd: Command): Command {
  cmd
    .option("--output <list>", `comma-separated outputs: ${OUTPUT_NAMES.join(", ")} (server default: markdown,structured)`)
    .option("--extract <list>", `comma-separated extractors: ${EXTRACT_NAMES.join(", ")}`)
    .option("--schema-file <file>", "JSON Schema file for structured extraction (sent as `schema`)")
    .option("--wait-for <expr>", "wait for a CSS selector, css:<sel>, or js:<expr> before capture (max 1024 chars)")
    .option("--wait-timeout-ms <n>", "budget for --wait-for in ms, 0-60000 (server default: 30000)")
    .option("--js-code <src>", "JavaScript to run on the page before capture; @file reads a file (max 20000 chars)")
    .option("--viewport <WxH>", "viewport size, e.g. 1440x900 (width 320-3840, height 240-2160)")
    .option("--mobile", "emulate a mobile device")
    .option("--respect-robots", "honour robots.txt")
    .option("--full-page", "keep the full page content including navigation and site chrome (server default strips it)")
    .addOption(
      new Option("--cache-mode <mode>", "render cache behaviour (server default: enabled)").choices([
        "enabled",
        "bypass",
        "refresh",
      ]),
    )
    .option("--block-resource <list>", `comma-separated resource types to block: ${RESOURCE_TYPES.join(", ")}`)
    .option("--header <header>", "extra request header 'Name: value' (repeatable, max 20)", collectRepeatable, [])
    .option("--cookie <cookie>", "cookie 'name=value;domain=…' or 'name=value;url=…' (repeatable, max 50)", collectRepeatable, [])
    .option("--basic-auth <user:pass>", "HTTP basic auth credentials")
    .option("--pdf-page-size <size>", "PDF page size: A0-A6, B0-B5, Letter, Legal, Tabloid, Ledger (default A4)")
    .addOption(new Option("--pdf-orientation <o>", "PDF orientation (default portrait)").choices(["portrait", "landscape"]))
    .option("--pdf-margin <t,r,b,l>", "PDF margins in mm; one value or top,right,bottom,left (default 10)")
    .option("--pdf-scale <f>", "PDF render scale 0.1-2.0 (default 1.0)")
    .option("--pdf-grayscale", "grayscale PDF output")
    .option("--pdf-header <html>", "PDF header HTML (max 2000 chars)")
    .option("--pdf-footer <html>", "PDF footer HTML (max 2000 chars)")
    .option("--pdf-header-height <mm>", "PDF header height in mm (server default: 15)")
    .option("--pdf-footer-height <mm>", "PDF footer height in mm (server default: 15)")
    .option("--pdf-page-width <mm>", "custom PDF page width in mm (use with --pdf-page-height)")
    .option("--pdf-page-height <mm>", "custom PDF page height in mm");
  return cmd;
}

/**
 * PerceiveOptionsBase from the user's flags — only fields the user set.
 * pdf_options is attached only when the requested outputs include "pdf",
 * mirroring the schema's intent (the gateway ignores it otherwise).
 */
function buildPerceiveOptions(opts: PerceiveOptionFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  let outputs: string[] | undefined;
  if (opts.output !== undefined) {
    outputs = validatedList(opts.output, OUTPUT_NAMES, "--output");
    body["outputs"] = outputs;
  }
  if (opts.extract !== undefined) body["extract"] = validatedList(opts.extract, EXTRACT_NAMES, "--extract");
  if (opts.schemaFile !== undefined) body["schema"] = readJsonObject(opts.schemaFile, "--schema-file");
  if (opts.waitFor !== undefined) body["wait_for"] = opts.waitFor;
  if (opts.waitTimeoutMs !== undefined) body["wait_timeout_ms"] = intFlag(opts.waitTimeoutMs, "--wait-timeout-ms", 0, 60000);
  if (opts.jsCode !== undefined) body["js_code"] = readInlineOrFile(opts.jsCode, "--js-code");
  if (opts.viewport !== undefined) body["viewport"] = parseViewport(opts.viewport);
  if (opts.mobile === true) body["mobile"] = true;
  if (opts.respectRobots === true) body["respect_robots"] = true;
  // The server default is main-content-only; only the explicit opt-out is worth sending.
  if (opts.fullPage === true) body["only_main_content"] = false;
  if (opts.cacheMode !== undefined) body["cache_mode"] = opts.cacheMode;
  if (opts.blockResource !== undefined) {
    body["block_resources"] = validatedList(opts.blockResource, RESOURCE_TYPES, "--block-resource");
  }
  if (opts.header.length > 0) body["headers"] = parseHeaderFlags(opts.header);
  if (opts.cookie.length > 0) body["cookies"] = parseCookieFlags(opts.cookie);
  if (opts.basicAuth !== undefined) body["auth"] = parseBasicAuth(opts.basicAuth);
  const pdf = buildPdfOptions(opts);
  if (pdf !== undefined) {
    if (outputs !== undefined && outputs.includes("pdf")) {
      body["pdf_options"] = pdf;
    } else {
      warn("--pdf-* flags are ignored unless --output includes pdf");
    }
  }
  return body;
}

function extForOutput(name: string): string {
  if (name.startsWith("markdown")) return "md";
  if (name === "html_cleaned" || name === "html_raw") return "html";
  if (name.startsWith("screenshot")) return "png";
  if (name === "pdf") return "pdf";
  return "json"; // links, images, structured
}

function slugForUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\//i, "").replace(/[?#].*$/, "");
  const slug = stripped
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug === "" ? "page" : slug;
}

async function renderPerceive(
  ctx: Context,
  res: v2.PerceiveResponse,
  opts: { outputDir?: string; urlOnly?: boolean; showStructured?: boolean },
): Promise<void> {
  if (emitJson(ctx, res)) return;
  const outputs = res.outputs ?? {};
  if (opts.urlOnly === true) {
    for (const artifact of Object.values(outputs)) {
      if (artifact.url !== undefined) out(artifact.url);
    }
    return;
  }
  for (const w of res.warnings ?? []) warn(w);
  if (res.error !== undefined) warn(`server reported: ${res.error}`);
  const quality = res.render_quality !== undefined ? `, quality ${res.render_quality.toFixed(2)}` : "";
  const sourceStatus = res.status_code !== undefined && res.status_code !== null ? `, source status: ${res.status_code}` : "";
  const cache = res.cache_hit === true ? ", cache hit" : "";
  info(`perceive ${res.operation_id}: ${res.status}${quality}${sourceStatus}${cache}`);
  const deductions = Object.entries(res.deductions ?? {});
  if (deductions.length > 0) {
    info(`deductions: ${deductions.map(([name, value]) => `${name} ${value.toFixed(2)}`).join(", ")}`);
  }
  if (res.status === "queued" || res.status === "processing") {
    info(`still running; check later with: enconvert perceive get ${res.operation_id}`);
  }
  if (opts.outputDir !== undefined) {
    const slug = slugForUrl(res.url_final ?? res.url);
    for (const [name, artifact] of Object.entries(outputs)) {
      if (artifact.url === undefined) {
        warn(`output ${name} has no download URL`);
        continue;
      }
      const derived = `${slug}.${name}.${extForOutput(name)}`;
      const dest = resolveArtifactPath(ctx, { outputDir: opts.outputDir }, derived);
      if (dest === null) {
        info(`skipping existing ${derived}`);
        continue;
      }
      await downloadToFile(ctx, artifact.url, dest, { label: name });
      out(dest);
    }
    return;
  }
  for (const artifact of Object.values(outputs)) {
    if (artifact.url !== undefined) out(artifact.url);
  }
  if (opts.showStructured === true && res.structured !== undefined) {
    printJson(res.structured);
  }
}

/**
 * --direct-download: the POST response body IS the single artifact's bytes
 * (no JSON envelope, no presigned URL); metadata rides in X-* headers.
 */
async function runDirectDownload(
  ctx: Context,
  body: Record<string, unknown>,
  opts: PerceiveCmdOpts,
): Promise<void> {
  const outputs = body["outputs"] as string[] | undefined;
  if (outputs === undefined || outputs.length !== 1) {
    throw usageError("--direct-download needs exactly one --output artifact", {
      help: ["e.g. --direct-download --output pdf -o page.pdf"],
    });
  }
  if (opts.urlOnly === true) throw usageError("--direct-download streams bytes; drop --url-only");
  if (opts.outputDir !== undefined) {
    throw usageError("--direct-download writes a single artifact; use -o <path>, not -O <dir>");
  }
  body["direct_download"] = true;
  const { bytes, headers } = await v2.perceiveDirect(ctx, body);
  const warningsCount = Number(headers.get("x-warnings-count") ?? 0);
  if (warningsCount > 0) {
    warn(`server reported ${warningsCount} warning(s); re-run without --direct-download for details`);
  }
  if (opts.outputFile === "-") {
    outBytes(bytes);
    return;
  }
  const output = outputs[0]!;
  const derived = `${slugForUrl(body["url"] as string)}.${output}.${extForOutput(output)}`;
  const dest = resolveArtifactPath(
    ctx,
    opts.outputFile !== undefined ? { output: opts.outputFile } : {},
    derived,
  );
  if (dest === null) {
    info(`skipping existing ${derived}`);
    return;
  }
  atomicWriteFile(dest, bytes);
  out(dest);
}

async function renderBatch(
  ctx: Context,
  batch: v2.PerceiveBatchResponse,
  opts: { output?: string; outputDir?: string; urlOnly?: boolean },
): Promise<void> {
  if (emitJson(ctx, batch)) return;
  if (ctx.opts.jsonl === true) {
    for (const item of batch.items ?? []) printJsonl(item);
    return;
  }
  for (const w of batch.warnings ?? []) warn(w);
  info(
    `batch ${batch.job_id}: ${batch.status} (${batch.completed ?? 0}/${batch.total ?? 0} completed, ${batch.failed ?? 0} failed)`,
  );
  if (batch.output_mode === "zip") {
    const zipUrl = batch.zip?.url;
    if (zipUrl === undefined) {
      if (batch.status === "completed" || batch.status === "partial") warn("no zip artifact in the response");
      return;
    }
    const wantsDownload = (opts.output !== undefined || opts.outputDir !== undefined) && opts.urlOnly !== true;
    if (!wantsDownload) {
      out(zipUrl);
      return;
    }
    if (opts.output === "-") {
      await downloadToStdout(ctx, zipUrl);
      return;
    }
    const derived = `${batch.job_id}.zip`;
    const dest = resolveArtifactPath(ctx, opts, derived);
    if (dest === null) {
      info(`skipping existing ${derived}`);
      return;
    }
    await downloadToFile(ctx, zipUrl, dest, { label: derived });
    out(dest);
    return;
  }
  for (const item of batch.items ?? []) {
    info(`${item.url} -> ${item.status}${item.error !== undefined ? ` (${item.error})` : ""}`);
    for (const artifact of Object.values(item.outputs ?? {})) {
      if (artifact.url !== undefined) out(artifact.url);
    }
  }
}

function readUrlFile(path: string, flag: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw inputNotFoundError(`cannot read ${flag} file: ${path}`);
  }
  const urls: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    urls.push(requireHttpUrl(trimmed, `URL in ${path}`));
  }
  return urls;
}

export function registerPerceiveCommands(program: Command): void {
  const perceive = program
    .command("perceive")
    .alias("scrape")
    .description("Render one URL and capture outputs: markdown, HTML, screenshots, PDF, links, structured data (POST /v2/perceive).")
    .argument("<url>", "page URL (http:// or https://)")
    .option("-O, --output-dir <dir>", "download every produced artifact into this directory")
    .addOption(new Option("-o, --output-file <path>", "direct download: write the artifact to this path ('-' streams bytes to stdout)"))
    .option("--url-only", "print only the presigned artifact URLs")
    .option("--direct-download", "stream the artifact's bytes as the response body (needs exactly one --output)");
  addPerceiveOptions(perceive);
  perceive
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert perceive https://example.com --output markdown,links,screenshot -O ./out
  $ enconvert perceive https://example.com --extract tables,metadata --schema-file s.json --json
  $ enconvert perceive https://example.com --output pdf --pdf-page-size Letter --url-only
  $ enconvert perceive https://example.com --direct-download --output markdown -o page.md
`,
    )
    .action(async (url: string, opts: PerceiveCmdOpts, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const body: Record<string, unknown> = {
        url: requireHttpUrl(url),
        ...buildPerceiveOptions(opts),
      };
      if (opts.directDownload === true) {
        await runDirectDownload(ctx, body, opts);
        return;
      }
      const res = await v2.perceive(ctx, body);
      const requestedOutputs = body["outputs"] as string[] | undefined;
      const showStructured =
        requestedOutputs?.includes("structured") === true ||
        opts.schemaFile !== undefined ||
        opts.extract !== undefined;
      await renderPerceive(ctx, res, {
        ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        ...(opts.urlOnly !== undefined ? { urlOnly: opts.urlOnly } : {}),
        showStructured,
      });
      // A sync render that failed server-side must not exit 0.
      if (res.status === "failed") process.exitCode = EXIT.SERVER_FAILURE;
    });

  perceive
    .command("get <operation_id>")
    .description("Fetch a previous perceive operation with freshly signed URLs (GET /v2/perceive/{operation_id}).")
    .option("-O, --output-dir <dir>", "download every artifact into this directory")
    .option("--url-only", "print only the presigned artifact URLs")
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert perceive get per_ab12cd34 --json
  $ enconvert perceive get per_ab12cd34 -O ./out
`,
    )
    .action(async (operationId: string, opts: { outputDir?: string; urlOnly?: boolean }, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const res = await v2.perceiveGet(ctx, operationId);
      await renderPerceive(ctx, res, {
        ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        ...(opts.urlOnly !== undefined ? { urlOnly: opts.urlOnly } : {}),
        showStructured: true,
      });
    });

  const batch = perceive
    .command("batch")
    .description("Perceive up to 1000 URLs in one job (POST /v2/perceive/batch; finishes inline on 200, queues on 202).")
    .argument("[urls...]", "page URLs (or use --input-file)")
    .option("--input-file <file>", "read URLs from a file: one per line, # comments allowed")
    .addOption(new Option("--output-mode <mode>", "artifact packaging (server default: manifest)").choices(["manifest", "zip"]))
    .addOption(new Option("-o, --output-file <path>", "zip mode: download the archive to this path ('-' streams bytes to stdout)"))
    .option("-O, --output-dir <dir>", "zip mode: download the archive into this directory");
  addPerceiveOptions(batch);
  addWaitOptions(batch);
  batch
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert perceive batch https://a.com https://b.com --output markdown --jsonl
  $ enconvert perceive batch --input-file urls.txt --output-mode zip -o pages.zip
  $ enconvert perceive batch --input-file urls.txt --no-wait --json | jq -r .job_id
`,
    )
    .action(async (urls: string[], opts: BatchCmdOpts, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const list = urls.map((u) => requireHttpUrl(u));
      if (opts.inputFile !== undefined) list.push(...readUrlFile(opts.inputFile, "--input-file"));
      if (list.length === 0) throw usageError("no URLs given; pass URLs as arguments or --input-file <file>");
      if (list.length > 1000) {
        throw usageError(`too many URLs (${list.length}); the gateway accepts at most 1000 per batch`);
      }
      const body: Record<string, unknown> = { urls: list };
      const options = buildPerceiveOptions(opts);
      if (Object.keys(options).length > 0) body["options"] = options;
      if (opts.outputMode !== undefined) body["output_mode"] = opts.outputMode;

      const { status, batch: submitted } = await v2.perceiveBatch(ctx, body);
      if (status === 202 && opts.wait !== true) {
        const hint = {
          job_id: submitted.job_id,
          status: submitted.status,
          poll: `enconvert jobs wait ${submitted.job_id}`,
        };
        if (!emitJson(ctx, hint)) {
          info(`batch queued; poll with: enconvert jobs wait ${submitted.job_id}`);
          out(submitted.job_id);
        }
        return;
      }
      let finished = submitted;
      if (status === 202) {
        const outcome = await waitForPerceiveBatch(ctx, submitted.job_id, waitOptionsFrom(opts));
        finished = outcome.result;
      }
      await renderBatch(ctx, finished, {
        ...(opts.outputFile !== undefined ? { output: opts.outputFile } : {}),
        ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        ...(opts.urlOnly !== undefined ? { urlOnly: opts.urlOnly } : {}),
      });
      if (opts.exitStatus === true && finished.status === "failed") {
        process.exitCode = EXIT.SERVER_FAILURE;
      }
    });

  batch
    .command("get <job_id>")
    .description("Fetch a perceive batch's status and artifacts (GET /v2/perceive/batch/{job_id}).")
    .addOption(new Option("-o, --output-file <path>", "zip mode: download the archive to this path ('-' streams bytes to stdout)"))
    .option("-O, --output-dir <dir>", "zip mode: download the archive into this directory")
    .option("--url-only", "print URLs only; never download")
    .action(
      async (
        jobId: string,
        opts: { outputFile?: string; outputDir?: string; urlOnly?: boolean },
        cmdObj: Command,
      ) => {
        const ctx = contextFor(cmdObj);
        const res = await v2.perceiveBatchGet(ctx, jobId);
        await renderBatch(ctx, res, {
          ...(opts.outputFile !== undefined ? { output: opts.outputFile } : {}),
          ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
          ...(opts.urlOnly !== undefined ? { urlOnly: opts.urlOnly } : {}),
        });
      },
    );

  batch
    .command("cancel <job_id>")
    .description("Cancel a perceive batch; completed URLs keep their artifacts (DELETE /v2/perceive/batch/{job_id}). Idempotent.")
    .action(async (jobId: string, _opts: Record<string, never>, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const res = await v2.perceiveBatchCancel(ctx, jobId);
      if (emitJson(ctx, res)) return;
      info(`batch ${res.job_id}: ${res.status} (${res.completed ?? 0}/${res.total ?? 0} completed before cancel)`);
    });
}
