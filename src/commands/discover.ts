// enconvert discover — POST /v2/discover (hidden alias: map).
// Fields transcribed 1:1 from the gateway's DiscoverRequest schema; only
// values the user explicitly set are sent so server defaults stay in charge.
import { Option, type Command } from "commander";
import { usageError } from "../api/errors.js";
import * as v2 from "../api/v2.js";
import { printJsonl } from "../output/json.js";
import { info, out, warn } from "../output/streams.js";
import { collectRepeatable, contextFor } from "../program.js";
import { emitJson, requireHttpUrl } from "./_shared.js";

interface DiscoverCmdOpts {
  mode?: string;
  maxUrls?: string;
  maxDepth?: string;
  includePattern: string[];
  excludePattern: string[];
  sameDomainOnly?: boolean;
  respectRobots?: boolean;
  renderJs?: string;
}

function intFlag(raw: string, flag: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`${flag} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

export function registerDiscoverCommands(program: Command): void {
  program
    .command("discover <url>")
    .alias("map")
    .description("Discover a site's URLs via sitemap and/or crawl (POST /v2/discover). URLs land on stdout, one per line.")
    .addOption(new Option("--mode <mode>", "discovery strategy (server default: hybrid)").choices(["sitemap", "crawl", "hybrid"]))
    .option("--max-urls <n>", "maximum URLs to return, 1-1000 (server default: 100)")
    .option("--max-depth <n>", "crawl depth, 1-5 (server default: 2)")
    .option("--include-pattern <regex>", "keep only URLs matching this regex (repeatable, max 50)", collectRepeatable, [])
    .option("--exclude-pattern <regex>", "drop URLs matching this regex, applied after includes (repeatable, max 50)", collectRepeatable, [])
    .option("--same-domain-only", "restrict results to the seed domain (server default)")
    .option("--no-same-domain-only", "allow URLs on other domains")
    .option("--respect-robots", "filter out URLs disallowed by robots.txt")
    .addOption(new Option("--render-js <mode>", "JS rendering during crawl (server default: auto)").choices(["auto", "never", "always"]))
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert discover https://example.com --mode hybrid --max-urls 500
  $ enconvert discover https://example.com --include-pattern '/blog/' --jsonl
  $ enconvert discover https://example.com --render-js always | head -20
`,
    )
    .action(async (url: string, opts: DiscoverCmdOpts, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const body: Record<string, unknown> = { url: requireHttpUrl(url) };
      if (opts.mode !== undefined) body["mode"] = opts.mode;
      if (opts.maxUrls !== undefined) body["max_urls"] = intFlag(opts.maxUrls, "--max-urls", 1, 1000);
      if (opts.maxDepth !== undefined) body["max_depth"] = intFlag(opts.maxDepth, "--max-depth", 1, 5);
      if (opts.includePattern.length > 0) body["include_patterns"] = opts.includePattern;
      if (opts.excludePattern.length > 0) body["exclude_patterns"] = opts.excludePattern;
      if (opts.sameDomainOnly !== undefined) body["same_domain_only"] = opts.sameDomainOnly;
      if (opts.respectRobots === true) body["respect_robots"] = true;
      if (opts.renderJs !== undefined) body["render_js"] = opts.renderJs;

      const res = await v2.discover(ctx, body);
      if (emitJson(ctx, res)) return;
      if (ctx.opts.jsonl === true) {
        for (const discovered of res.urls) printJsonl(discovered);
        return;
      }
      for (const discovered of res.urls) out(discovered);
      for (const w of res.warnings ?? []) warn(w);
      const sources = Object.entries(res.sources ?? {})
        .map(([source, count]) => `${source}=${count}`)
        .join(", ");
      info(
        `discovered ${res.total} URLs (mode ${res.mode}${res.truncated === true ? ", truncated" : ""}${sources !== "" ? `; sources: ${sources}` : ""})`,
      );
    });
}
