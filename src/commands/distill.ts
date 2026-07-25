// enconvert distill — POST /v2/distill (hidden alias: extract).
// Fields transcribed 1:1 from the gateway's DistillRequest schema. Two rules
// the server enforces are checked client-side for fast, quota-free failures:
// urls XOR discover_from, and at least one of schema/prompt.
import { readFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { inputNotFoundError, usageError } from "../api/errors.js";
import * as v2 from "../api/v2.js";
import { printJson, printJsonl } from "../output/json.js";
import { info, verbose, warn } from "../output/streams.js";
import { collectRepeatable, contextFor } from "../program.js";
import { emitJson, parseCookieFlags, parseHeaderFlags, requireHttpUrl } from "./_shared.js";

interface DistillCmdOpts {
  discoverFrom?: string;
  discoverMode?: string;
  discoverMaxPages?: string;
  schemaFile?: string;
  prompt?: string;
  cssSchemaFile?: string;
  waitFor?: string;
  waitTimeoutMs?: string;
  header: string[];
  cookie: string[];
  respectRobots?: boolean;
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

export function registerDistillCommands(program: Command): void {
  program
    .command("distill [urls...]")
    .alias("extract")
    .description("Extract structured data from pages using a schema, a prompt, or CSS selectors (POST /v2/distill).")
    .option("--discover-from <url>", "discover pages from this seed instead of listing URLs")
    .addOption(
      new Option("--discover-mode <mode>", "discovery strategy for --discover-from (server default: hybrid)").choices([
        "sitemap",
        "crawl",
        "hybrid",
      ]),
    )
    .option("--discover-max-pages <n>", "max discovered pages to distill, 1-50 (server default: 10)")
    .option("--schema-file <file>", "JSON Schema (or flat field:description map) describing the fields to extract")
    .option("--prompt <text>", "natural-language description of what to extract (max 2000 chars; a schema is synthesized)")
    .option("--css-schema-file <file>", "CSS extraction schema file: {baseSelector, fields[]} (sent as css_schema)")
    .option("--wait-for <expr>", "wait for a CSS selector, css:<sel>, or js:<expr> before capture (max 1024 chars)")
    .option("--wait-timeout-ms <n>", "budget for --wait-for in ms, 0-60000 (server default: 30000)")
    .option("--header <header>", "extra request header 'Name: value' (repeatable, max 20)", collectRepeatable, [])
    .option("--cookie <cookie>", "cookie 'name=value;domain=…' or 'name=value;url=…' (repeatable, max 50)", collectRepeatable, [])
    .option("--respect-robots", "honour robots.txt")
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert distill https://a.com https://b.com --schema-file schema.json
  $ enconvert distill --discover-from https://shop.com --discover-max-pages 25 --prompt "product name and price"
  $ enconvert distill https://docs.example.com --prompt "API endpoints" --json
`,
    )
    .action(async (urlArgs: string[], opts: DistillCmdOpts, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const urls = urlArgs.map((u) => requireHttpUrl(u));
      if (urls.length > 0 && opts.discoverFrom !== undefined) {
        throw usageError("pass URLs or --discover-from, not both (the gateway rejects the combination)");
      }
      if (urls.length === 0 && opts.discoverFrom === undefined) {
        throw usageError("distill needs URLs as arguments or --discover-from <url>");
      }
      if (urls.length > 50) {
        throw usageError(`too many URLs (${urls.length}); the gateway distills at most 50 per call`);
      }
      if (opts.schemaFile === undefined && opts.prompt === undefined) {
        throw usageError("at least one of --schema-file or --prompt is required", {
          help: [
            "--schema-file s.json for a precise JSON Schema",
            '--prompt "product name and price" to synthesize one',
          ],
        });
      }

      const body: Record<string, unknown> = {};
      if (urls.length > 0) body["urls"] = urls;
      if (opts.discoverFrom !== undefined) {
        const discoverFrom: Record<string, unknown> = {
          url: requireHttpUrl(opts.discoverFrom, "--discover-from"),
        };
        if (opts.discoverMode !== undefined) discoverFrom["mode"] = opts.discoverMode;
        if (opts.discoverMaxPages !== undefined) {
          discoverFrom["max_pages"] = intFlag(opts.discoverMaxPages, "--discover-max-pages", 1, 50);
        }
        body["discover_from"] = discoverFrom;
      } else if (opts.discoverMode !== undefined || opts.discoverMaxPages !== undefined) {
        throw usageError("--discover-mode/--discover-max-pages need --discover-from <url>");
      }
      if (opts.schemaFile !== undefined) body["schema"] = readJsonObject(opts.schemaFile, "--schema-file");
      if (opts.prompt !== undefined) {
        if (opts.prompt.trim() === "") throw usageError("--prompt must not be blank");
        if (opts.prompt.length > 2000) throw usageError("--prompt is limited to 2000 characters");
        body["prompt"] = opts.prompt;
      }
      if (opts.cssSchemaFile !== undefined) body["css_schema"] = readJsonObject(opts.cssSchemaFile, "--css-schema-file");
      if (opts.waitFor !== undefined) body["wait_for"] = opts.waitFor;
      if (opts.waitTimeoutMs !== undefined) {
        body["wait_timeout_ms"] = intFlag(opts.waitTimeoutMs, "--wait-timeout-ms", 0, 60000);
      }
      if (opts.header.length > 0) body["headers"] = parseHeaderFlags(opts.header);
      if (opts.cookie.length > 0) body["cookies"] = parseCookieFlags(opts.cookie);
      if (opts.respectRobots === true) body["respect_robots"] = true;

      const res = await v2.distill(ctx, body);
      if (emitJson(ctx, res)) return;
      if (ctx.opts.jsonl === true) {
        for (const item of res.results ?? []) printJsonl(item);
        return;
      }
      for (const w of res.warnings ?? []) warn(w);
      if (res.synthesized_schema !== undefined) {
        verbose(`synthesized schema: ${JSON.stringify(res.synthesized_schema)}`);
      }
      const results = res.results ?? [];
      for (const item of results) {
        const tier = item.extraction_tier ?? "none";
        info(`${item.url} -> ${item.status} (${tier})${item.error !== undefined ? `: ${item.error}` : ""}`);
      }
      if (results.length === 1) {
        printJson(results[0]!.data ?? null);
      } else {
        for (const item of results) printJsonl(item.data ?? null);
      }
      info(`distill ${res.operation_id}: ${res.completed}/${res.total} completed, ${res.failed} failed`);
    });
}
