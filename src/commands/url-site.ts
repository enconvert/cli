// v1 URL rendering (`url pdf|screenshot|markdown`) and website crawling
// (`site pdf|screenshot`), plus the hidden top-level `screenshot` alias.
//
// Body-building rule (api-contract section 4): a field is included ONLY when
// the user actually set the flag — the gateway applies its own defaults, and
// re-sending them would mask future server-side default changes. Commander's
// getOptionValueSource distinguishes user input from defaults, which is the
// only reliable signal for --flag/--no-flag pairs.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { downloadToFile, downloadToStdout } from "../api/download.js";
import { EXIT, inputNotFoundError, usageError } from "../api/errors.js";
import { urlConvert, websiteConvert, type AsyncAccepted, type SyncEnvelope } from "../api/v1.js";
import type { Context } from "../config/resolve.js";
import { printJsonl } from "../output/json.js";
import { info, out, outBytes, verbose, warn } from "../output/streams.js";
import { addWaitOptions, collectRepeatable, contextFor } from "../program.js";
import { toAbsolute } from "../util/files.js";
import { waitForV1Batch } from "../util/poll.js";
import {
  emitJson,
  parseBasicAuth,
  parseCookieFlags,
  parseHeaderFlags,
  requireHttpUrl,
  resolveArtifactPath,
  waitOptionsFrom,
} from "./_shared.js";

type UrlKind = "pdf" | "screenshot" | "markdown";
type SiteKind = "pdf" | "screenshot";

interface UrlSiteCliOpts {
  output?: string;
  outputDir?: string;
  urlOnly?: boolean;
  wait?: boolean;
  pollInterval?: number;
  waitTimeout?: string;
  exitStatus?: boolean;
  async?: boolean;
  crawlMode?: string;
  includePattern?: string[];
  excludePattern?: string[];
  [key: string]: unknown;
}

function intArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new InvalidArgumentError("expected an integer");
  return n;
}

function floatArg(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new InvalidArgumentError("expected a number");
  return n;
}

/** camelCase option attribute -> snake_case gateway field, sent only when user-set. */
const RENDER_FIELDS: Array<{ attr: string; field: string }> = [
  { attr: "viewportWidth", field: "viewport_width" },
  { attr: "viewportHeight", field: "viewport_height" },
  { attr: "waitForSelector", field: "wait_for_selector" },
  { attr: "waitForSelectorTimeout", field: "wait_for_selector_timeout" },
  { attr: "loadMedia", field: "load_media" },
  { attr: "enableScroll", field: "enable_scroll" },
  { attr: "stickyHeader", field: "handle_sticky_header" },
  { attr: "handleCookies", field: "handle_cookies" },
  { attr: "waitForImages", field: "wait_for_images" },
  { attr: "blockAds", field: "block_ads" },
  { attr: "blockMedia", field: "block_media" },
  { attr: "notificationEmail", field: "notification_email" },
  { attr: "callbackUrl", field: "callback_url" },
  { attr: "outputFilename", field: "output_filename" },
  { attr: "jobId", field: "job_id" },
  { attr: "async", field: "async_mode" },
  { attr: "singlePage", field: "single_page" },
];

function renderBodyFrom(cmd: Command): Record<string, unknown> {
  const opts = cmd.opts<Record<string, unknown>>();
  const body: Record<string, unknown> = {};
  for (const { attr, field } of RENDER_FIELDS) {
    if (cmd.getOptionValueSource(attr) === "cli") body[field] = opts[attr];
  }
  const basicAuth = opts["basicAuth"];
  if (typeof basicAuth === "string") body["auth"] = parseBasicAuth(basicAuth);
  const cookies = opts["cookie"];
  if (Array.isArray(cookies) && cookies.length > 0) body["cookies"] = parseCookieFlags(cookies as string[]);
  const headers = opts["header"];
  if (Array.isArray(headers) && headers.length > 0) body["headers"] = parseHeaderFlags(headers as string[]);
  if (opts["zip"] === true) body["output_format"] = "zip";
  return body;
}

function readHtmlFlagValue(raw: string, flagName: string): string {
  if (!raw.startsWith("@")) return raw;
  const path = raw.slice(1);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw inputNotFoundError(`cannot read ${flagName} file: ${path}`);
  }
}

function parseMargins(raw: string): { top: number; right: number; bottom: number; left: number } {
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw usageError(`invalid --pdf-margin "${raw}" (expected four numbers: top,right,bottom,left in mm)`);
  }
  return { top: parts[0]!, right: parts[1]!, bottom: parts[2]!, left: parts[3]! };
}

/** Build the nested pdf_options OBJECT (URL-render bodies take JSON, not a string). */
function pdfOptionsObjectFrom(opts: Record<string, unknown>): Record<string, unknown> | undefined {
  const o: Record<string, unknown> = {};
  if (opts["pdfPageSize"] !== undefined) o["page_size"] = opts["pdfPageSize"];
  if (opts["pdfPageWidth"] !== undefined) o["page_width"] = opts["pdfPageWidth"];
  if (opts["pdfPageHeight"] !== undefined) o["page_height"] = opts["pdfPageHeight"];
  if (opts["pdfOrientation"] !== undefined) o["orientation"] = opts["pdfOrientation"];
  if (typeof opts["pdfMargin"] === "string") o["margins"] = parseMargins(opts["pdfMargin"]);
  if (opts["pdfScale"] !== undefined) o["scale"] = opts["pdfScale"];
  if (opts["pdfGrayscale"] === true) o["grayscale"] = true;
  if (opts["pdfHeader"] !== undefined || opts["pdfHeaderHeight"] !== undefined) {
    const header: Record<string, unknown> = {
      content: typeof opts["pdfHeader"] === "string" ? readHtmlFlagValue(opts["pdfHeader"], "--pdf-header") : "",
    };
    if (opts["pdfHeaderHeight"] !== undefined) header["height"] = opts["pdfHeaderHeight"];
    o["header"] = header;
  }
  if (opts["pdfFooter"] !== undefined || opts["pdfFooterHeight"] !== undefined) {
    const footer: Record<string, unknown> = {
      content: typeof opts["pdfFooter"] === "string" ? readHtmlFlagValue(opts["pdfFooter"], "--pdf-footer") : "",
    };
    if (opts["pdfFooterHeight"] !== undefined) footer["height"] = opts["pdfFooterHeight"];
    o["footer"] = footer;
  }
  return Object.keys(o).length > 0 ? o : undefined;
}

/** Derived download name: host + path slug + the proper extension. */
function urlDerivedName(rawUrl: string, ext: string): string {
  let host = rawUrl;
  let path = "";
  try {
    const parsed = new URL(rawUrl);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    // keep the raw string; resolveArtifactPath only uses the basename
  }
  const slug = path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = slug === "" ? host : `${host}-${slug}`;
  return `${base}.${ext}`;
}

async function handleSyncEnvelope(
  ctx: Context,
  opts: UrlSiteCliOpts,
  sourceUrl: string,
  ext: string,
  envelope: SyncEnvelope,
): Promise<void> {
  if (ctx.opts.jsonl === true) {
    printJsonl(envelope);
    return;
  }
  if (emitJson(ctx, envelope)) return;
  if (opts.output === "-") {
    // The gateway only streams bytes to private keys; when the envelope came
    // back anyway, fetch the presigned URL and stream that instead.
    await downloadToStdout(ctx, envelope.presigned_url);
    return;
  }
  if (opts.urlOnly === true) {
    out(envelope.presigned_url);
    return;
  }
  const derived = urlDerivedName(sourceUrl, ext);
  const dest = resolveArtifactPath(
    ctx,
    { ...(opts.output !== undefined ? { output: opts.output } : {}), ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}) },
    derived,
  );
  if (dest === null) {
    verbose(`skipping ${sourceUrl}: output exists (--skip-existing)`);
    return;
  }
  await downloadToFile(ctx, envelope.presigned_url, dest, { label: `downloading ${basename(dest)}` });
  out(toAbsolute(dest));
}

async function handleAcceptedBatch(
  ctx: Context,
  opts: UrlSiteCliOpts,
  accepted: AsyncAccepted,
  ext: string,
): Promise<void> {
  if (opts.wait === false) {
    if (!emitJson(ctx, accepted)) out(accepted.batch_id);
    info(`poll with: enconvert jobs wait ${accepted.batch_id}`);
    return;
  }
  const outcome = await waitForV1Batch(ctx, accepted.batch_id, waitOptionsFrom(opts));
  if (opts.exitStatus === true && outcome.failed) process.exitCode = EXIT.SERVER_FAILURE;
  const batch = outcome.result;
  if (ctx.opts.jsonl === true) {
    for (const item of batch.items) printJsonl(item);
    return;
  }
  if (emitJson(ctx, batch)) return;
  info(`batch ${batch.batch_id}: ${batch.status} (${batch.completed}/${batch.total} done, ${batch.failed} failed)`);

  if (batch.output_mode === "zip" && batch.zip_download_url !== undefined && batch.zip_download_url !== "") {
    if (opts.urlOnly === true) {
      out(batch.zip_download_url);
      return;
    }
    const dest = resolveArtifactPath(
      ctx,
      { ...(opts.output !== undefined ? { output: opts.output } : {}), ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}) },
      `${batch.batch_id}.zip`,
    );
    if (dest === null) {
      verbose(`skipping ${batch.batch_id}.zip: output exists (--skip-existing)`);
      return;
    }
    await downloadToFile(ctx, batch.zip_download_url, dest, { label: `downloading ${basename(dest)}` });
    out(toAbsolute(dest));
    return;
  }

  for (const item of batch.items) {
    if (item.download_url === undefined || item.download_url === "") {
      warn(`${item.source_url}: ${item.status}, no download URL`);
      continue;
    }
    if (opts.urlOnly === true) {
      out(item.download_url);
      continue;
    }
    const dest = resolveArtifactPath(
      ctx,
      opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {},
      urlDerivedName(item.source_url, ext),
    );
    if (dest === null) {
      verbose(`skipping ${item.source_url}: output exists (--skip-existing)`);
      continue;
    }
    await downloadToFile(ctx, item.download_url, dest, { label: `downloading ${basename(dest)}` });
    out(toAbsolute(dest));
  }
}

async function runUrlRender(cmd: Command, kind: UrlKind, rawUrls: string[]): Promise<void> {
  const ctx = contextFor(cmd);
  const opts = cmd.opts<UrlSiteCliOpts>();
  const urls = rawUrls.map((u) => requireHttpUrl(u));
  const endpoint = `/v1/convert/url-to-${kind}`;
  const ext = kind === "pdf" ? "pdf" : kind === "screenshot" ? "png" : "md";

  const toStdout = opts.output === "-";
  if (opts.output !== undefined && urls.length > 1) {
    throw usageError(
      toStdout ? "-o - streams bytes and needs exactly one URL" : "-o <file> with multiple URLs would write them all to the same file",
      { help: ["use -O <dir> for multi-URL output"] },
    );
  }
  if (toStdout && opts.async === true) {
    throw usageError("-o - requires a synchronous render; drop --async");
  }

  const body = renderBodyFrom(cmd);
  if (kind !== "screenshot") {
    const pdfOptions = pdfOptionsObjectFrom(cmd.opts<Record<string, unknown>>());
    if (pdfOptions !== undefined) body["pdf_options"] = pdfOptions;
  }
  body["url"] = urls.length === 1 ? urls[0] : urls;
  // direct_download only when the caller explicitly asked for bytes on stdout.
  if (toStdout) body["direct_download"] = true;

  if (ctx.opts.dryRun === true) {
    for (const u of urls) out(`${u} -> POST ${endpoint}`);
    return;
  }

  const result = await urlConvert(ctx, endpoint, body);
  if (result.kind === "bytes") {
    outBytes(result.bytes);
    return;
  }
  if (result.kind === "sync") {
    await handleSyncEnvelope(ctx, opts, urls[0]!, ext, result.envelope);
    return;
  }
  await handleAcceptedBatch(ctx, opts, result.accepted, ext);
}

async function runSiteCrawl(cmd: Command, kind: SiteKind, rawUrl: string): Promise<void> {
  const ctx = contextFor(cmd);
  const opts = cmd.opts<UrlSiteCliOpts>();
  const target = requireHttpUrl(rawUrl);
  const endpoint = `/v1/convert/website-to-${kind}`;
  const ext = kind === "pdf" ? "pdf" : "png";

  if (opts.output === "-") {
    throw usageError("site output is a ZIP batch; write it with -o <path> or -O <dir>");
  }
  const includePatterns = opts.includePattern ?? [];
  const excludePatterns = opts.excludePattern ?? [];
  if ((includePatterns.length > 0 || excludePatterns.length > 0) && opts.crawlMode !== "full") {
    warn("--include-pattern/--exclude-pattern only apply with --crawl-mode full; the gateway ignores them otherwise");
  }

  const body = renderBodyFrom(cmd);
  body["url"] = target;
  if (cmd.getOptionValueSource("crawlMode") === "cli") body["crawl_mode"] = opts.crawlMode;
  if (includePatterns.length > 0) body["include_patterns"] = includePatterns;
  if (excludePatterns.length > 0) body["exclude_patterns"] = excludePatterns;

  if (ctx.opts.dryRun === true) {
    out(`${target} -> POST ${endpoint}`);
    return;
  }

  const accepted = await websiteConvert(ctx, endpoint, body);
  await handleAcceptedBatch(ctx, opts, accepted, ext);
}

interface RenderFlagOptions {
  /** async_mode/output_format apply to url-to-* only; website-to-* rejects them. */
  asyncZip: boolean;
}

function addRenderFlags(cmd: Command, flags: RenderFlagOptions): Command {
  cmd
    .option("--viewport-width <px>", "viewport width (gateway default 1920)", intArg)
    .option("--viewport-height <px>", "viewport height (gateway default 1080)", intArg)
    .option("--wait-for-selector <selector>", "wait for a CSS selector before capturing")
    .option("--wait-for-selector-timeout <ms>", "selector wait budget in ms (max 60000)", intArg)
    .option("--load-media", "load images and media (gateway default)")
    .option("--no-load-media", "skip images and media")
    .option("--enable-scroll", "scroll the page to trigger lazy loading (gateway default)")
    .option("--no-enable-scroll", "do not scroll the page")
    .option("--sticky-header", "neutralize sticky headers (gateway default; maps handle_sticky_header)")
    .option("--no-sticky-header", "leave sticky headers alone")
    .option("--handle-cookies", "auto-dismiss cookie banners (gateway default)")
    .option("--no-handle-cookies", "leave cookie banners alone")
    .option("--wait-for-images", "wait for images to finish loading (gateway default)")
    .option("--no-wait-for-images", "do not wait for images")
    .option("--block-ads", "block ad network requests")
    .option("--block-media", "block heavy media requests")
    .option("--basic-auth <user:pass>", "HTTP basic auth for the target site")
    .option("--cookie <cookie>", "cookie 'name=value;domain=...' (repeatable)", collectRepeatable, [])
    .option("--header <header>", "extra request header 'Name: value' (repeatable)", collectRepeatable, [])
    .option("--notification-email <email>", "completion email (private keys)")
    .option("--callback-url <url>", "completion webhook URL (plan-gated)")
    .option("--output-filename <name>", "server-side output filename (a timestamp is always appended)")
    .option("--job-id <id>", "client-supplied job id (crash-recovery handle)");
  if (flags.asyncZip) {
    cmd
      .option("--async", "queue the render and return a batch id (202)")
      .option("--no-async", "force a synchronous render")
      .option("--zip", "bundle multiple URLs into a single ZIP");
  }
  return cmd;
}

function addPdfGeometryFlags(cmd: Command): Command {
  return cmd
    .option("--single-page", "render as one tall page (gateway default)")
    .option("--no-single-page", "paginate the output")
    .option("--pdf-page-size <size>", "page size: A0-A6, B0-B5, Letter, Legal, Tabloid, Ledger")
    .addOption(new Option("--pdf-orientation <orientation>", "page orientation").choices(["portrait", "landscape"]))
    .option("--pdf-margin <t,r,b,l>", "margins in mm, e.g. 20,15,20,15")
    .option("--pdf-scale <n>", "render scale 0.1-2.0", floatArg)
    .option("--pdf-grayscale", "convert the output PDF to grayscale")
    .option("--pdf-header <html|@file>", "header HTML (@file reads from disk)")
    .option("--pdf-footer <html|@file>", "footer HTML (@file reads from disk)")
    .option("--pdf-header-height <mm>", "header height in mm", floatArg)
    .option("--pdf-footer-height <mm>", "footer height in mm", floatArg)
    .option("--pdf-page-width <mm>", "custom page width in mm (use with --pdf-page-height)", floatArg)
    .option("--pdf-page-height <mm>", "custom page height in mm", floatArg);
}

function buildUrlSubcommand(cmd: Command, kind: UrlKind, description: string): void {
  cmd
    .description(description)
    .option("-o, --output <path>", 'output file, or "-" for bytes on stdout (single URL only)')
    .option("-O, --output-dir <dir>", "output directory for multi-URL results");
  addRenderFlags(cmd, { asyncZip: true });
  if (kind !== "screenshot") addPdfGeometryFlags(cmd);
  addWaitOptions(cmd);
  cmd
    .addHelpText(
      "after",
      `
Examples:
  enconvert url ${kind} https://example.com
  enconvert url ${kind} https://example.com --url-only
  enconvert url ${kind} https://a.com https://b.com --zip -O out/
  enconvert url ${kind} https://example.com --basic-auth user:pass --header 'X-Env: staging'`,
    )
    .action(async (urls: string[], _opts: unknown, c: Command) => {
      await runUrlRender(c, kind, urls);
    });
}

function buildSiteSubcommand(cmd: Command, kind: SiteKind, description: string): void {
  cmd
    .description(description)
    .addOption(new Option("--crawl-mode <mode>", "page discovery strategy (plan-gated)").choices(["auto", "sitemap", "full"]))
    .option("--include-pattern <re>", "include URLs matching this regex (full crawl only; repeatable)", collectRepeatable, [])
    .option("--exclude-pattern <re>", "exclude URLs matching this regex (full crawl only; repeatable)", collectRepeatable, [])
    .option("-o, --output <path>", "output path for the result ZIP")
    .option("-O, --output-dir <dir>", "output directory");
  addRenderFlags(cmd, { asyncZip: false });
  addWaitOptions(cmd);
  cmd
    .addHelpText(
      "after",
      `
Examples:
  enconvert site ${kind} https://example.com --crawl-mode sitemap
  enconvert site ${kind} https://example.com --crawl-mode full --include-pattern '/docs/'
  enconvert site ${kind} https://example.com --no-wait --json`,
    )
    .action(async (url: string, _opts: unknown, c: Command) => {
      await runSiteCrawl(c, kind, url);
    });
}

export function registerUrlSiteCommands(program: Command): void {
  const url = program.command("url").description("render URLs to PDF, screenshots, or Markdown");
  buildUrlSubcommand(url.command("pdf <urls...>"), "pdf", "render web pages to PDF");
  buildUrlSubcommand(url.command("screenshot <urls...>"), "screenshot", "capture full-page screenshots (PNG)");
  buildUrlSubcommand(url.command("markdown <urls...>"), "markdown", "extract web pages as Markdown");

  // Hidden muscle-memory alias: `enconvert screenshot <url>` == `url screenshot`.
  buildUrlSubcommand(
    program.command("screenshot <urls...>", { hidden: true }),
    "screenshot",
    "capture full-page screenshots (alias of `url screenshot`)",
  );

  const site = program.command("site").description("crawl a website and convert every discovered page (always async)");
  buildSiteSubcommand(site.command("pdf <url>"), "pdf", "crawl a site and render every page to PDF (ZIP result)");
  buildSiteSubcommand(site.command("screenshot <url>"), "screenshot", "crawl a site and screenshot every page (ZIP result)");
}
