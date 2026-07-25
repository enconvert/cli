// v1 file conversion: `convert` (the default command) plus the data/compress/
// pdf/markdown aliases. The 46 upload routes never become 46 subcommands —
// the endpoint is inferred from (input extension | --from, --to) via the
// generated route table, or forced with --endpoint.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { downloadToFile, downloadToStdout } from "../api/download.js";
import { CliError, EXIT, inputNotFoundError, unsupportedError, usageError } from "../api/errors.js";
import type { UploadFieldValues } from "../api/multipart.js";
import type { UploadRoute } from "../api/routes.generated.js";
import { canonicalFormat, findRouteByName, resolveRoute } from "../api/routes.js";
import { uploadConvert, type SyncEnvelope } from "../api/v1.js";
import type { Context } from "../config/resolve.js";
import { renderError } from "../output/errors.js";
import { printJsonl } from "../output/json.js";
import { startProgress } from "../output/progress.js";
import { out, verbose, warn } from "../output/streams.js";
import { contextFor } from "../program.js";
import { extOf, replaceExt, statInput, toAbsolute } from "../util/files.js";
import { expandInputs } from "../util/glob.js";
import { emitJson, resolveArtifactPath } from "./_shared.js";

interface ConvertCliOpts {
  to?: string;
  from?: string;
  endpoint?: string;
  output?: string;
  outputDir?: string;
  urlOnly?: boolean;
  outputFilename?: string;
  jobId?: string;
  pdfPageSize?: string;
  pdfOrientation?: string;
  pdfMargin?: string;
  pdfScale?: number;
  pdfGrayscale?: boolean;
  pdfHeader?: string;
  pdfFooter?: string;
  pdfHeaderHeight?: number;
  pdfFooterHeight?: number;
  pdfPageWidth?: number;
  pdfPageHeight?: number;
  width?: number;
  height?: number;
  targetSizeKb?: number;
}

interface PdfFlagState {
  /** The pdf_options payload, or undefined when no pdf flag was set. */
  options: Record<string, unknown> | undefined;
  /** True when any flag OTHER than --pdf-grayscale was set (geometry keys 400 on LibreOffice routes). */
  geometry: boolean;
  any: boolean;
}

interface ForcedResolution {
  routeName?: string;
  group?: UploadRoute["group"];
}

interface WorkItem {
  input: string;
  ext: string;
  route: UploadRoute;
}

/** anything-to-pdf inputs that render through LibreOffice and reject geometry keys. */
const GEOMETRY_LOCKED_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "ots",
  "pages", "numbers", "rtf", "csv", "pdf",
]);

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

function urlMenuError(url: string): CliError {
  // Never guess a metered action for a URL — each of these costs quota.
  return usageError(`"${url}" is a URL; \`convert\` uploads local files`, {
    help: [
      `enconvert url pdf ${url}         render the page to PDF`,
      `enconvert url screenshot ${url}  capture a screenshot`,
      `enconvert url markdown ${url}    extract the page as Markdown`,
      `enconvert perceive ${url}        structured web data (v2)`,
    ],
  });
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

function pdfOptionsFrom(opts: ConvertCliOpts): PdfFlagState {
  const options: Record<string, unknown> = {};
  let geometry = false;
  if (opts.pdfPageSize !== undefined) {
    options["page_size"] = opts.pdfPageSize;
    geometry = true;
  }
  if (opts.pdfPageWidth !== undefined) {
    options["page_width"] = opts.pdfPageWidth;
    geometry = true;
  }
  if (opts.pdfPageHeight !== undefined) {
    options["page_height"] = opts.pdfPageHeight;
    geometry = true;
  }
  if (opts.pdfOrientation !== undefined) {
    options["orientation"] = opts.pdfOrientation;
    geometry = true;
  }
  if (opts.pdfMargin !== undefined) {
    options["margins"] = parseMargins(opts.pdfMargin);
    geometry = true;
  }
  if (opts.pdfScale !== undefined) {
    options["scale"] = opts.pdfScale;
    geometry = true;
  }
  if (opts.pdfGrayscale === true) {
    options["grayscale"] = true;
  }
  if (opts.pdfHeader !== undefined || opts.pdfHeaderHeight !== undefined) {
    const header: Record<string, unknown> = {
      content: opts.pdfHeader !== undefined ? readHtmlFlagValue(opts.pdfHeader, "--pdf-header") : "",
    };
    if (opts.pdfHeaderHeight !== undefined) header["height"] = opts.pdfHeaderHeight;
    options["header"] = header;
    geometry = true;
  }
  if (opts.pdfFooter !== undefined || opts.pdfFooterHeight !== undefined) {
    const footer: Record<string, unknown> = {
      content: opts.pdfFooter !== undefined ? readHtmlFlagValue(opts.pdfFooter, "--pdf-footer") : "",
    };
    if (opts.pdfFooterHeight !== undefined) footer["height"] = opts.pdfFooterHeight;
    options["footer"] = footer;
    geometry = true;
  }
  const any = Object.keys(options).length > 0;
  return { options: any ? options : undefined, geometry, any };
}

function routeAccepts(route: UploadRoute, ext: string): boolean {
  return route.from.includes(`.${ext}`) || route.from.includes(`.${canonicalFormat(ext)}`);
}

function resolveRouteForInput(input: string, opts: ConvertCliOpts, forced?: ForcedResolution): { route: UploadRoute; ext: string } {
  const ext = (opts.from ?? extOf(input)).toLowerCase().replace(/^\./, "");
  if (forced?.routeName !== undefined) {
    const route = findRouteByName(forced.routeName);
    if (route === undefined) {
      throw new CliError(`internal error: route "${forced.routeName}" missing from the generated table`);
    }
    if (ext === "" || !routeAccepts(route, ext)) {
      throw unsupportedError(`${input}: .${ext === "" ? "?" : ext} is not accepted by ${route.name}`, {
        details: [`accepted extensions: ${route.from.join(" ")}`],
      });
    }
    return { route, ext };
  }
  if (opts.endpoint !== undefined) {
    const route = findRouteByName(opts.endpoint);
    if (route === undefined) {
      throw usageError(`unknown endpoint "${opts.endpoint}"`, {
        help: ["run `enconvert formats` to list endpoint names"],
      });
    }
    // --endpoint is the explicit escape hatch, so a mismatched extension only warns.
    if (ext !== "" && !routeAccepts(route, ext)) {
      warn(`${input}: .${ext} is not a documented input for ${route.name}; the gateway may reject it`);
    }
    return { route, ext };
  }
  if (opts.to === undefined) {
    throw usageError("missing required flag -t/--to (or --endpoint <name>)", {
      help: ["example: enconvert convert report.docx --to pdf"],
    });
  }
  if (ext === "") {
    throw usageError(`cannot infer the input format of ${input} (no file extension)`, {
      help: ["pass --from <fmt> or --endpoint <name>"],
    });
  }
  const route = resolveRoute(ext, opts.to);
  if (forced?.group !== undefined && route.group !== forced.group) {
    throw unsupportedError(`.${ext} -> ${opts.to} is not a ${forced.group} conversion`, {
      help: ["use `enconvert convert` for the full conversion matrix"],
    });
  }
  return { route, ext };
}

function enforceCapabilities(item: WorkItem, opts: ConvertCliOpts, pdf: PdfFlagState): void {
  const { route, ext, input } = item;
  if (pdf.any && route.pdfOptions === null) {
    throw unsupportedError(`--pdf-* options do not apply to ${route.name}`, {
      help: ["pdf options are only accepted by PDF-producing conversions", "run `enconvert params convert --from <fmt> --to pdf` to see what applies"],
    });
  }
  if (pdf.geometry && route.pdfOptions === "grayscale-only") {
    throw unsupportedError(`${route.name} supports only --pdf-grayscale`, {
      details: [
        "office documents render through LibreOffice, which controls page geometry itself;",
        "the gateway rejects page-size/orientation/margin/scale/header/footer options with 400",
      ],
    });
  }
  if (pdf.geometry && route.name === "anything-to-pdf" && GEOMETRY_LOCKED_EXTS.has(ext)) {
    throw unsupportedError(`${input}: .${ext} input renders through LibreOffice; only --pdf-grayscale applies`, {
      details: ["page geometry is honored only for html, markdown, text, epub, image, and svg inputs"],
    });
  }
  if ((opts.width !== undefined || opts.height !== undefined) && !route.widthHeight) {
    throw unsupportedError(`--width/--height apply only to svg-to-jpeg, svg-to-png and svg-to-webp (not ${route.name})`);
  }
  if (opts.targetSizeKb !== undefined && !route.targetSizeKb) {
    throw unsupportedError(`--target-size-kb applies only to compress-image`, {
      help: ["use `enconvert compress <file> --target-size-kb <n>`"],
    });
  }
}

/** Output filename derived from the input: same basename, target extension. */
function deriveOutputName(input: string, route: UploadRoute): string {
  const targetExt = route.to === "same-as-input" ? extOf(input) : route.to;
  return replaceExt(input, targetExt);
}

function plannedDestination(input: string, route: UploadRoute, opts: ConvertCliOpts): string {
  if (opts.urlOnly === true) return "(presigned URL)";
  if (opts.output === "-") return "stdout";
  if (opts.output !== undefined) return opts.output;
  const derived = deriveOutputName(input, route);
  return opts.outputDir !== undefined ? join(opts.outputDir, basename(derived)) : derived;
}

async function runPool(count: number, limit: number, run: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(limit, count));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= count) return;
        await run(index);
      }
    }),
  );
}

async function convertOne(
  ctx: Context,
  item: WorkItem,
  opts: ConvertCliOpts,
  pdf: PdfFlagState,
  jsonActive: boolean,
  results: Array<SyncEnvelope | undefined>,
  index: number,
): Promise<void> {
  let dest: string | null = null;
  const wantsFile = !jsonActive && ctx.opts.jsonl !== true && opts.urlOnly !== true && opts.output !== "-";
  if (wantsFile) {
    // Plan the output path BEFORE uploading so --skip-existing and the
    // refuse-to-overwrite check never burn quota.
    dest = resolveArtifactPath(ctx, { ...(opts.output !== undefined ? { output: opts.output } : {}), ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}) }, deriveOutputName(item.input, item.route));
    if (dest === null) {
      verbose(`skipping ${item.input}: output exists (--skip-existing)`);
      return;
    }
  }

  const fields: UploadFieldValues = {};
  if (opts.outputFilename !== undefined) fields["output_filename"] = opts.outputFilename;
  if (opts.jobId !== undefined) fields["job_id"] = opts.jobId;
  if (pdf.options !== undefined) fields["pdf_options"] = JSON.stringify(pdf.options);
  if (opts.width !== undefined) fields["width"] = String(opts.width);
  if (opts.height !== undefined) fields["height"] = String(opts.height);
  if (opts.targetSizeKb !== undefined) fields["target_size_kb"] = String(opts.targetSizeKb);

  const envelope = await uploadConvert(ctx, item.route.endpoint, item.input, fields);

  if (ctx.opts.jsonl === true) {
    printJsonl(envelope);
    return;
  }
  if (jsonActive) {
    results[index] = envelope;
    return;
  }
  if (opts.urlOnly === true) {
    out(envelope.presigned_url);
    return;
  }
  if (opts.output === "-") {
    await downloadToStdout(ctx, envelope.presigned_url);
    return;
  }
  await downloadToFile(ctx, envelope.presigned_url, dest as string, { label: `downloading ${basename(dest as string)}` });
  out(toAbsolute(dest as string));
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/**
 * `convert` is the default command, so a mistyped subcommand ("perceve") lands
 * here as a "file". When the token was default-routed (argv[2] is not the
 * command name), is extensionless, path-less and does not exist, treat it as an
 * unknown command: exit 2 with a suggestion — never exit 3.
 */
function guardMistypedCommand(cmd: Command, firstRaw: string): void {
  if (process.argv[2] === cmd.name()) return; // explicit `enconvert convert ...`
  if (firstRaw.includes(".") || firstRaw.includes("/") || firstRaw.includes("\\")) return;
  if (existsSync(firstRaw)) return;
  let root: Command = cmd;
  while (root.parent !== null && root.parent !== undefined) root = root.parent as Command;
  const names = root.commands
    .flatMap((c) => [c.name(), ...c.aliases()])
    .filter((n) => n !== "" && !n.startsWith("_"));
  let best: string | undefined;
  let bestDist = Infinity;
  for (const name of names) {
    const d = levenshtein(firstRaw.toLowerCase(), name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  throw usageError(`unknown command "${firstRaw}"`, {
    help: [
      ...(best !== undefined && bestDist <= 3 ? [`did you mean \`enconvert ${best}\`?`] : []),
      "run `enconvert --help` for the command list",
    ],
  });
}

async function runConversions(cmd: Command, rawInputs: string[], forced?: ForcedResolution): Promise<void> {
  const ctx = contextFor(cmd);
  const opts = cmd.opts<ConvertCliOpts>();

  // Check the raw first argument before glob expansion: URLs can contain glob
  // magic ("?") and would otherwise die inside expandInputs with exit 3.
  const firstRaw = rawInputs[0]!;
  if (/^https?:\/\//i.test(firstRaw)) throw urlMenuError(firstRaw);
  guardMistypedCommand(cmd, firstRaw);

  const inputs = expandInputs(rawInputs);
  if (opts.output !== undefined && inputs.length > 1) {
    throw usageError(
      opts.output === "-"
        ? "-o - streams bytes and needs exactly one input"
        : "-o <file> with multiple inputs would write them all to the same file",
      { help: ["use -O <dir> to direct multi-input output"] },
    );
  }
  if (opts.jobId !== undefined && inputs.length > 1) {
    throw usageError("--job-id is a per-job handle and needs exactly one input");
  }

  // Resolve every route and enforce flag capabilities up front so a bad flag
  // fails fast without spending quota on earlier inputs.
  const pdf = pdfOptionsFrom(opts);
  const items: WorkItem[] = inputs.map((input) => {
    statInput(input);
    const { route, ext } = resolveRouteForInput(input, opts, forced);
    const item: WorkItem = { input, ext, route };
    enforceCapabilities(item, opts, pdf);
    return item;
  });

  if (ctx.opts.dryRun === true) {
    for (const item of items) {
      out(`${item.input} -> ${item.route.name} -> ${plannedDestination(item.input, item.route, opts)}`);
    }
    return;
  }

  const jsonActive = ctx.opts.json === true || ctx.opts.jq !== undefined || ctx.opts.template !== undefined;
  const results: Array<SyncEnvelope | undefined> = new Array<SyncEnvelope | undefined>(items.length);
  const failures: Array<unknown | undefined> = new Array<unknown | undefined>(items.length);
  const progress = startProgress(`converting 0/${items.length}`, {
    noProgress: ctx.opts.noProgress,
    jsonMode: ctx.opts.json === true || ctx.opts.jsonl === true,
  });
  let startedCount = 0;
  try {
    await runPool(items.length, ctx.concurrency, async (index) => {
      const item = items[index]!;
      startedCount += 1;
      progress.update(`converting ${startedCount}/${items.length} ${basename(item.input)}`);
      try {
        await convertOne(ctx, item, opts, pdf, jsonActive, results, index);
      } catch (e) {
        failures[index] = e;
        renderError(e, { debug: ctx.opts.debug === true });
      }
    });
  } finally {
    progress.stop();
  }

  if (jsonActive && ctx.opts.jsonl !== true) {
    const succeeded = results.filter((r): r is SyncEnvelope => r !== undefined);
    if (items.length === 1) {
      if (succeeded[0] !== undefined) emitJson(ctx, succeeded[0]);
    } else {
      emitJson(ctx, succeeded);
    }
  }

  const firstFailure = failures.find((f) => f !== undefined);
  if (firstFailure !== undefined) {
    process.exitCode = firstFailure instanceof CliError ? firstFailure.exitCode : EXIT.GENERIC;
  }
}

function addOutputFlags(cmd: Command): Command {
  return cmd
    .option("-o, --output <path>", 'output file, or "-" for bytes on stdout (single input only)')
    .option("-O, --output-dir <dir>", "output directory for multi-file results")
    .option("--url-only", "print the presigned URL, skip the download")
    .option("--output-filename <name>", "server-side output filename (a timestamp is always appended)")
    .option("--job-id <id>", "client-supplied job id (crash-recovery handle; single input only)");
}

function addPdfFlags(cmd: Command): Command {
  return cmd
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

export function registerConvertCommands(program: Command): void {
  const convert = program.command("convert <inputs...>", { isDefault: true });
  convert
    .description("convert local files; the endpoint is inferred from the extension and --to")
    .option("-t, --to <fmt>", "target format (required unless --endpoint)")
    .option("--from <fmt>", "override the input format sniffed from the extension")
    .option("--endpoint <name>", "exact gateway route name, e.g. doc-to-pdf");
  addOutputFlags(convert);
  addPdfFlags(convert);
  convert
    .option("--width <px>", "output width (svg-to-jpeg/png/webp only)", intArg)
    .option("--height <px>", "output height (svg-to-jpeg/png/webp only)", intArg)
    .option("--target-size-kb <n>", "target size in KB (compress-image only)", intArg)
    .addHelpText(
      "after",
      `
Examples:
  enconvert convert report.docx --to pdf
  enconvert convert *.docx --to pdf -O out/ --skip-existing
  enconvert convert logo.svg --to png --width 1024 -o logo.png
  enconvert convert diagram.svg --to png -o - | pbcopy
  enconvert convert notes.md --to pdf --pdf-page-size Letter --pdf-margin 20,15,20,15
  enconvert report.docx --to pdf              (convert is the default command)`,
    )
    .action(async (inputs: string[], _opts: unknown, cmd: Command) => {
      await runConversions(cmd, inputs);
    });

  const data = program.command("data <inputs...>");
  data
    .description("convert between data formats (the 11 data routes)")
    .addOption(
      new Option("-t, --to <fmt>", "target data format")
        .choices(["json", "xml", "yaml", "csv", "toml", "html"])
        .makeOptionMandatory(),
    );
  addOutputFlags(data);
  data
    .addHelpText("after", "\nExamples:\n  enconvert data config.json -t yaml\n  enconvert data *.csv -t json -O out/")
    .action(async (inputs: string[], _opts: unknown, cmd: Command) => {
      await runConversions(cmd, inputs, { group: "data" });
    });

  const compress = program.command("compress <files...>");
  compress
    .description("compress images (png, jpeg, webp); output keeps the input extension")
    .option("--target-size-kb <n>", "target size in KB (>= 1)", intArg);
  addOutputFlags(compress);
  compress
    .addHelpText("after", "\nExamples:\n  enconvert compress hero.png --target-size-kb 200 -o hero-small.png")
    .action(async (files: string[], _opts: unknown, cmd: Command) => {
      await runConversions(cmd, files, { routeName: "compress-image" });
    });

  const pdf = program.command("pdf <files...>");
  pdf.description("convert anything to PDF (anything-to-pdf)");
  addOutputFlags(pdf);
  addPdfFlags(pdf);
  pdf
    .addHelpText("after", "\nExamples:\n  enconvert pdf slides.pptx\n  enconvert pdf notes.md --pdf-page-size Letter")
    .action(async (files: string[], _opts: unknown, cmd: Command) => {
      await runConversions(cmd, files, { routeName: "anything-to-pdf" });
    });

  const markdown = program.command("markdown <files...>");
  markdown.description("convert documents to Markdown (anything-to-markdown)");
  addOutputFlags(markdown);
  markdown
    .addHelpText("after", "\nExamples:\n  enconvert markdown paper.pdf\n  enconvert markdown *.docx -O md/")
    .action(async (files: string[], _opts: unknown, cmd: Command) => {
      await runConversions(cmd, files, { routeName: "anything-to-markdown" });
    });
}
