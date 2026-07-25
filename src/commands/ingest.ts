// enconvert ingest — the /v2/ingest family: create (urls/sitemap/crawl),
// files (multipart), list/get/cancel, retry-webhook and webhook-secret.
// Fields transcribed 1:1 from the gateway's IngestRequest schema; only values
// the user explicitly set are sent so server defaults stay in charge.
import { readFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { downloadToFile, downloadToStdout } from "../api/download.js";
import { ApiError, CliError, EXIT, inputNotFoundError, usageError } from "../api/errors.js";
import * as v2 from "../api/v2.js";
import type { Context } from "../config/resolve.js";
import { printJsonl } from "../output/json.js";
import { renderTable } from "../output/table.js";
import { info, out, warn } from "../output/streams.js";
import { addWaitOptions, collectRepeatable, contextFor } from "../program.js";
import { expandInputs } from "../util/glob.js";
import { waitForIngest } from "../util/poll.js";
import { confirm, emitJson, requireHttpUrl, resolveArtifactPath, waitOptionsFrom } from "./_shared.js";

interface CreateCmdOpts {
  urlFile?: string;
  mode?: string;
  maxPages?: string;
  maxDepth?: string;
  includePattern: string[];
  excludePattern: string[];
  sameDomainOnly?: boolean;
  respectRobots?: boolean;
  waitFor?: string;
  waitTimeoutMs?: string;
  chunkMaxWords?: string;
  chunkSentenceOverlap?: string;
  webhookUrl?: string;
  output?: string;
  wait?: boolean;
  pollInterval?: number;
  waitTimeout?: string;
  exitStatus?: boolean;
  urlOnly?: boolean;
}

interface FilesCmdOpts {
  maxWords?: string;
  sentenceOverlap?: string;
  webhookUrl?: string;
  output?: string;
  wait?: boolean;
  pollInterval?: number;
  waitTimeout?: string;
  exitStatus?: boolean;
  urlOnly?: boolean;
}

function intFlag(raw: string, flag: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`${flag} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
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

function describeIngestJob(job: v2.IngestJobResponse): string {
  const pages = `${job.pages_processed ?? 0}/${job.pages_discovered ?? 0} pages`;
  const failedPages = (job.pages_failed ?? 0) > 0 ? `, ${job.pages_failed} failed` : "";
  return `ingest ${job.job_id}: ${job.status} (${pages}${failedPages}, ${job.total_chunks ?? 0} chunks)`;
}

/**
 * Shared post-submit flow for `create` and `files`: the gateway always answers
 * 202, so either print the handle (--no-wait) or poll to a terminal state and
 * surface the completed JSONL artifact.
 */
async function handleIngestJobFlow(
  ctx: Context,
  job: v2.IngestJobResponse,
  opts: {
    output?: string;
    wait?: boolean;
    pollInterval?: number;
    waitTimeout?: string;
    exitStatus?: boolean;
    urlOnly?: boolean;
  },
): Promise<void> {
  if (opts.wait !== true) {
    const hint = { job_id: job.job_id, status: job.status, poll: `enconvert jobs wait ${job.job_id}` };
    if (!emitJson(ctx, hint)) {
      info(`ingest job queued; poll with: enconvert jobs wait ${job.job_id}`);
      out(job.job_id);
    }
    return;
  }
  const outcome = await waitForIngest(ctx, job.job_id, waitOptionsFrom(opts));
  const finished = outcome.result;
  if (!emitJson(ctx, finished)) {
    for (const w of finished.warnings ?? []) warn(w);
    info(describeIngestJob(finished));
    if (finished.error_message !== undefined) warn(`error: ${finished.error_message}`);
    if (finished.status === "completed" && finished.output_url !== undefined) {
      if (opts.urlOnly === true || opts.output === undefined) {
        out(finished.output_url);
      } else if (opts.output === "-") {
        await downloadToStdout(ctx, finished.output_url);
      } else {
        const derived = `${finished.job_id}.jsonl`;
        const dest = resolveArtifactPath(ctx, { output: opts.output }, derived);
        if (dest !== null) {
          await downloadToFile(ctx, finished.output_url, dest, { label: derived });
          out(dest);
        } else {
          info(`skipping existing ${derived}`);
        }
      }
    }
  }
  if (opts.exitStatus === true && outcome.failed) process.exitCode = EXIT.SERVER_FAILURE;
}

function renderSecret(ctx: Context, res: v2.WebhookSecretResponse): void {
  if (emitJson(ctx, res)) return;
  info(`signature header: ${res.signature_header} (${res.signature_scheme} HMAC over the timestamped payload)`);
  info(`timestamp header: ${res.timestamp_header} (replay tolerance ${res.replay_tolerance_seconds}s)`);
  if (res.rotated) info("secret rotated; update every webhook consumer now");
  out(res.secret);
}

export function registerIngestCommands(program: Command): void {
  const ingest = program
    .command("ingest")
    .description("Ingest web pages or files into chunked JSONL for RAG pipelines (/v2/ingest).");

  const create = ingest
    .command("create [urls...]")
    .description("Create an ingest job from explicit URLs, a sitemap, or a crawl (POST /v2/ingest, 202).")
    .option("--url-file <file>", "read URLs from a file: one per line, # comments allowed")
    .addOption(
      new Option("--mode <mode>", "urls (default) takes a URL list; sitemap/crawl take exactly one seed URL").choices([
        "urls",
        "sitemap",
        "crawl",
      ]),
    )
    .option("--max-pages <n>", "discovery cap for sitemap/crawl, 1-1000 (server default: 50)")
    .option("--max-depth <n>", "crawl depth, 1-5 (server default: 2)")
    .option("--include-pattern <regex>", "keep only URLs matching this regex (repeatable, max 50)", collectRepeatable, [])
    .option("--exclude-pattern <regex>", "drop URLs matching this regex (repeatable, max 50)", collectRepeatable, [])
    .option("--same-domain-only", "restrict discovery to the seed domain (server default)")
    .option("--no-same-domain-only", "allow other domains during discovery")
    .option("--respect-robots", "honour robots.txt")
    .option("--wait-for <expr>", "wait for a CSS selector, css:<sel>, or js:<expr> on each page (max 1024 chars)")
    .option("--wait-timeout-ms <n>", "budget for --wait-for in ms, 0-60000 (server default: 30000)")
    .option("--chunk-max-words <n>", "words per chunk, 32-4000 (server default: 512)")
    .option("--chunk-sentence-overlap <n>", "sentences of overlap between chunks, 0-10 (server default: 1)")
    .option("--webhook-url <url>", "webhook called on completion (signed; see `enconvert ingest webhook-secret show`)")
    .option("-o, --output <path>", "download the completed JSONL to this path ('-' streams to stdout)");
  addWaitOptions(create);
  create
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert ingest create https://docs.example.com --mode crawl --max-pages 200 --no-wait
  $ enconvert ingest create https://a.com/page1 https://a.com/page2 --chunk-max-words 400
  $ enconvert ingest create https://example.com/sitemap.xml --mode sitemap -o chunks.jsonl
`,
    )
    .action(async (urlArgs: string[], opts: CreateCmdOpts, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const urls = urlArgs.map((u) => requireHttpUrl(u));
      if (opts.urlFile !== undefined) urls.push(...readUrlFile(opts.urlFile, "--url-file"));
      const mode = opts.mode ?? "urls";

      const body: Record<string, unknown> = {};
      if (opts.mode !== undefined) body["mode"] = opts.mode;
      if (mode === "urls") {
        if (urls.length === 0) throw usageError("urls mode needs at least one URL (arguments or --url-file)");
        if (urls.length > 1000) {
          throw usageError(`too many URLs (${urls.length}); the gateway accepts at most 1000 per job`);
        }
        body["urls"] = urls;
      } else {
        if (urls.length !== 1) {
          throw usageError(`${mode} mode takes exactly one seed URL (got ${urls.length})`);
        }
        body["url"] = urls[0];
      }
      if (opts.maxPages !== undefined) body["max_pages"] = intFlag(opts.maxPages, "--max-pages", 1, 1000);
      if (opts.maxDepth !== undefined) body["max_depth"] = intFlag(opts.maxDepth, "--max-depth", 1, 5);
      if (opts.includePattern.length > 0) body["include_patterns"] = opts.includePattern;
      if (opts.excludePattern.length > 0) body["exclude_patterns"] = opts.excludePattern;
      if (opts.sameDomainOnly !== undefined) body["same_domain_only"] = opts.sameDomainOnly;
      if (opts.respectRobots === true) body["respect_robots"] = true;
      if (opts.waitFor !== undefined) body["wait_for"] = opts.waitFor;
      if (opts.waitTimeoutMs !== undefined) {
        body["wait_timeout_ms"] = intFlag(opts.waitTimeoutMs, "--wait-timeout-ms", 0, 60000);
      }
      const chunk: Record<string, unknown> = {};
      if (opts.chunkMaxWords !== undefined) {
        chunk["max_words"] = intFlag(opts.chunkMaxWords, "--chunk-max-words", 32, 4000);
      }
      if (opts.chunkSentenceOverlap !== undefined) {
        chunk["sentence_overlap"] = intFlag(opts.chunkSentenceOverlap, "--chunk-sentence-overlap", 0, 10);
      }
      if (Object.keys(chunk).length > 0) body["chunk"] = chunk;
      if (opts.webhookUrl !== undefined) body["webhook_url"] = requireHttpUrl(opts.webhookUrl, "--webhook-url");

      const job = await v2.ingestCreate(ctx, body);
      await handleIngestJobFlow(ctx, job, opts);
    });

  const files = ingest
    .command("files <paths...>")
    .description("Ingest local files, 1-200 per job (POST /v2/ingest/files, multipart, 202).")
    .option("--max-words <n>", "words per chunk, 32-4000 (server default: 512)")
    .option("--sentence-overlap <n>", "sentences of overlap between chunks, 0-10 (server default: 1)")
    .option("--webhook-url <url>", "webhook called on completion (signed; see `enconvert ingest webhook-secret show`)")
    .option("-o, --output <path>", "download the completed JSONL to this path ('-' streams to stdout)");
  addWaitOptions(files);
  files
    .addHelpText(
      "after",
      `
Examples:
  $ enconvert ingest files ./docs/*.pdf --max-words 400
  $ enconvert ingest files report.docx notes.md --no-wait --json | jq -r .job_id
`,
    )
    .action(async (paths: string[], opts: FilesCmdOpts, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const expanded = expandInputs(paths);
      if (expanded.length === 0) throw usageError("no input files given");
      if (expanded.length > 200) {
        throw usageError(`too many files (${expanded.length}); the gateway accepts at most 200 per job`);
      }
      const fields: { max_words?: number; sentence_overlap?: number; webhook_url?: string } = {};
      if (opts.maxWords !== undefined) fields.max_words = intFlag(opts.maxWords, "--max-words", 32, 4000);
      if (opts.sentenceOverlap !== undefined) {
        fields.sentence_overlap = intFlag(opts.sentenceOverlap, "--sentence-overlap", 0, 10);
      }
      if (opts.webhookUrl !== undefined) fields.webhook_url = requireHttpUrl(opts.webhookUrl, "--webhook-url");

      const job = await v2.ingestFiles(ctx, expanded, fields);
      await handleIngestJobFlow(ctx, job, opts);
    });

  ingest
    .command("list")
    .description("List this project's ingest jobs, newest first (GET /v2/ingest).")
    .option("--skip <n>", "rows to skip (server default: 0)")
    .option("--limit <n>", "rows to return, 1-100 (server default: 20)")
    .action(async (opts: { skip?: string; limit?: string }, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const query: { skip?: number; limit?: number } = {};
      if (opts.skip !== undefined) query.skip = intFlag(opts.skip, "--skip", 0, Number.MAX_SAFE_INTEGER);
      if (opts.limit !== undefined) query.limit = intFlag(opts.limit, "--limit", 1, 100);
      const res = await v2.ingestList(ctx, query);
      if (emitJson(ctx, res)) return;
      if (ctx.opts.jsonl === true) {
        for (const job of res.jobs) printJsonl(job);
        return;
      }
      if (res.jobs.length === 0) {
        info("no ingest jobs yet");
        return;
      }
      const rows = res.jobs.map((job) => [
        job.job_id,
        job.status,
        job.mode ?? "",
        `${job.pages_processed ?? 0}/${job.pages_discovered ?? 0}`,
        String(job.total_chunks ?? 0),
        job.created_at ?? "",
      ]);
      out(renderTable(rows, { header: ["JOB ID", "STATUS", "MODE", "PAGES", "CHUNKS", "CREATED"], rightAlign: [4] }));
      if (res.has_more) info(`more jobs available; try --skip ${res.skip + res.limit}`);
    });

  ingest
    .command("get <ing_id>")
    .description("Show one ingest job, including its output URL and webhook state (GET /v2/ingest/{ing_id}).")
    .action(async (ingId: string, _opts: Record<string, never>, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const job = await v2.ingestGet(ctx, ingId);
      if (emitJson(ctx, job)) return;
      info(describeIngestJob(job));
      if (job.mode !== undefined) info(`mode: ${job.mode}`);
      if (job.created_at !== undefined) info(`created: ${job.created_at}`);
      if (job.completed_at !== undefined) info(`completed: ${job.completed_at}`);
      if (job.webhook_url !== undefined) {
        info(`webhook: ${job.webhook_url} (${job.webhook_delivered === true ? "delivered" : "not delivered"})`);
      }
      if (job.error_message !== undefined) warn(`error: ${job.error_message}`);
      for (const w of job.warnings ?? []) warn(w);
      if (job.output_url !== undefined) out(job.output_url);
    });

  ingest
    .command("cancel <ing_id>")
    .description("Cancel an ingest job; terminal jobs are returned unchanged (DELETE /v2/ingest/{ing_id}). Idempotent.")
    .action(async (ingId: string, _opts: Record<string, never>, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const job = await v2.ingestCancel(ctx, ingId);
      if (emitJson(ctx, job)) return;
      info(describeIngestJob(job));
    });

  ingest
    .command("retry-webhook <ing_id>")
    .description("Re-deliver the completion webhook for a completed job (POST /v2/ingest/{ing_id}/retry-webhook).")
    .action(async (ingId: string, _opts: Record<string, never>, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      let res: v2.WebhookRetryResponse;
      try {
        res = await v2.ingestRetryWebhook(ctx, ingId);
      } catch (e) {
        // 400/409 carry the reason in the envelope; add the actionable context.
        if (e instanceof ApiError && e.status === 409) {
          throw new CliError(e.message, {
            exitCode: e.exitCode,
            details: e.details,
            help: [
              "webhooks can only be retried once the job's status is completed",
              `check progress with: enconvert ingest get ${ingId}`,
            ],
          });
        }
        if (e instanceof ApiError && e.status === 400) {
          throw new CliError(e.message, {
            exitCode: e.exitCode,
            details: e.details,
            help: ["the job has no webhook configured, or its URL now resolves to a blocked address"],
          });
        }
        throw e;
      }
      if (emitJson(ctx, res)) return;
      const statusNote = res.status_code !== undefined ? ` (HTTP ${res.status_code})` : "";
      info(`webhook ${res.delivered ? "delivered" : "delivery failed"} after ${res.attempts} attempt(s)${statusNote}`);
      if (res.detail !== "") info(res.detail);
      if (!res.delivered) process.exitCode = EXIT.SERVER_FAILURE;
    });

  const secret = ingest
    .command("webhook-secret")
    .description("Show or rotate the per-project webhook signing secret.");

  secret
    .command("show")
    .description("Print the webhook signing secret (GET /v2/ingest/webhook-secret). Secret on stdout, headers on stderr.")
    .action(async (_opts: Record<string, never>, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const res = await v2.webhookSecretShow(ctx);
      renderSecret(ctx, res);
    });

  secret
    .command("rotate")
    .description("Rotate the webhook signing secret (POST /v2/ingest/webhook-secret/rotate). Asks for confirmation.")
    .action(async (_opts: Record<string, never>, cmdObj: Command) => {
      const ctx = contextFor(cmdObj);
      const ok = await confirm(
        ctx,
        "Rotate the webhook secret? Every existing consumer will fail signature verification until it uses the new secret.",
      );
      if (!ok) {
        info("rotation cancelled");
        process.exitCode = EXIT.GENERIC;
        return;
      }
      const res = await v2.webhookSecretRotate(ctx);
      renderSecret(ctx, res);
    });
}
