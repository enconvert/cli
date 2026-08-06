// enconvert lookup — POST /v2/lookup (hidden alias: search).
// Fields transcribed 1:1 from the gateway's LookupRequest / LookupEnrich
// schemas; the enrich object is only sent when the user set an enrich flag.
import { readFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { inputNotFoundError, usageError } from "../api/errors.js";
import * as v2 from "../api/v2.js";
import { printJsonl } from "../output/json.js";
import { renderTable } from "../output/table.js";
import { info, out, warn } from "../output/streams.js";
import { contextFor } from "../program.js";
import { csvList, emitJson } from "./_shared.js";

// OutputName enum shared with perceive (enrich reuses it).
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

interface LookupCmdOpts {
  category?: string;
  country?: string;
  locale?: string;
  timeFilter?: string;
  numResults?: string;
  page?: string;
  location?: string;
  autocorrect: boolean;
  perceiveTop?: string;
  enrichOutput?: string;
  enrichConcurrency?: string;
  enrichSchemaFile?: string;
  synthesizeAnswer?: boolean;
  answerPrompt?: string;
}

function intFlag(raw: string, flag: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`${flag} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
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

function truncateCell(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

export function registerLookupCommands(program: Command): void {
  program
    .command("lookup <query>")
    .alias("search")
    .description("Web search, optionally perceiving and enriching the top results (POST /v2/lookup).")
    .addOption(
      new Option("--category <cat>", "search vertical (server default: web)").choices([
        "web",
        "news",
        "images",
        "scholar",
        "patents",
        "maps",
      ]),
    )
    .option("--country <code>", "country bias, Google gl code (max 8 chars)")
    .option("--locale <code>", "interface locale, Google hl code (max 16 chars)")
    .addOption(new Option("--time-filter <window>", "restrict results by age").choices(["hour", "day", "week", "month", "year"]))
    .option("--num-results <n>", "results per page, 1-100 (server default: 10)")
    .option("--page <n>", "result page, 1-10 (server default: 1)")
    .option("--location <loc>", "location bias, e.g. 'Austin, Texas' (max 128 chars)")
    .option("--no-autocorrect", "disable query autocorrection")
    .option("--perceive-top <n>", "perceive the top N results, 0-10 (each consumes one perceive operation)")
    .option("--enrich-output <list>", `outputs for perceived results: ${OUTPUT_NAMES.join(", ")} (max 8; server default: markdown)`)
    .option("--enrich-concurrency <n>", "parallel enrich fetches, 1-5 (server default: 3)")
    .option("--enrich-schema-file <file>", "JSON Schema (or flat field:description map) for structured enrich extraction")
    .option("--synthesize-answer", "synthesize an LLM answer with citations across enriched results")
    .option("--answer-prompt <prompt>", "custom instruction for the synthesized answer (max 1000 chars)")
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert lookup "best pdf api 2026" --num-results 20
  $ enconvert lookup "playwright pricing" --perceive-top 3 --synthesize-answer
  $ enconvert lookup "site reliability" --category news --time-filter week --json
`,
    )
    .action(async (query: string, opts: LookupCmdOpts, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const trimmedQuery = query.trim();
      if (trimmedQuery === "") throw usageError("query must not be empty");
      if (trimmedQuery.length > 512) throw usageError("query is limited to 512 characters");

      const body: Record<string, unknown> = { query: trimmedQuery };
      if (opts.category !== undefined) body["category"] = opts.category;
      if (opts.country !== undefined) body["country"] = opts.country;
      if (opts.locale !== undefined) body["locale"] = opts.locale;
      if (opts.timeFilter !== undefined) body["time_filter"] = opts.timeFilter;
      if (opts.numResults !== undefined) body["num_results"] = intFlag(opts.numResults, "--num-results", 1, 100);
      if (opts.page !== undefined) body["page"] = intFlag(opts.page, "--page", 1, 10);
      if (opts.location !== undefined) body["location"] = opts.location;
      // --no-autocorrect is the only way autocorrect becomes false; the server
      // default is true, so only the explicit opt-out is worth sending.
      if (opts.autocorrect === false) body["autocorrect"] = false;
      let perceiveTop: number | undefined;
      if (opts.perceiveTop !== undefined) {
        perceiveTop = intFlag(opts.perceiveTop, "--perceive-top", 0, 10);
        body["perceive_top"] = perceiveTop;
      }

      const enrich: Record<string, unknown> = {};
      if (opts.enrichOutput !== undefined) {
        const outputs = csvList(opts.enrichOutput);
        for (const name of outputs) {
          if (!OUTPUT_NAMES.includes(name as (typeof OUTPUT_NAMES)[number])) {
            throw usageError(`invalid --enrich-output value "${name}"`, {
              help: [`valid values: ${OUTPUT_NAMES.join(", ")}`],
            });
          }
        }
        if (outputs.length > 8) throw usageError("--enrich-output takes at most 8 outputs");
        enrich["outputs"] = outputs;
      }
      if (opts.enrichConcurrency !== undefined) {
        enrich["concurrency"] = intFlag(opts.enrichConcurrency, "--enrich-concurrency", 1, 5);
      }
      if (opts.enrichSchemaFile !== undefined) {
        enrich["schema"] = readJsonObject(opts.enrichSchemaFile, "--enrich-schema-file");
      }
      if (opts.synthesizeAnswer === true) enrich["synthesize_answer"] = true;
      if (opts.answerPrompt !== undefined) {
        if (opts.synthesizeAnswer !== true) warn("--answer-prompt has no effect without --synthesize-answer");
        enrich["answer_prompt"] = opts.answerPrompt;
      }
      if (Object.keys(enrich).length > 0) {
        if (perceiveTop === undefined || perceiveTop === 0) {
          warn("enrich options only take effect with --perceive-top > 0");
        }
        body["enrich"] = enrich;
      }

      const res = await v2.lookup(ctx, body);
      if (emitJson(ctx, res)) return;
      if (ctx.opts.jsonl === true) {
        for (const result of res.results ?? []) printJsonl(result);
        return;
      }
      for (const w of res.warnings ?? []) warn(w);
      if (res.answer !== undefined) {
        out(res.answer);
        const sources = res.answer_sources ?? [];
        if (sources.length > 0) {
          out("");
          sources.forEach((source, i) => out(`[${i + 1}] ${source}`));
        }
        out("");
      }
      const results = res.results ?? [];
      if (results.length > 0) {
        const rows = results.map((r) => [
          r.position !== undefined ? String(r.position) : "",
          truncateCell(r.title ?? "", 60),
          r.url ?? "",
        ]);
        out(renderTable(rows, { header: ["#", "TITLE", "URL"], rightAlign: [0] }));
      }
      info(`${res.total ?? results.length} results for "${res.query}" (${res.category})`);
    });
}
