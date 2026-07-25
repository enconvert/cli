// Job waiting. Exponential backoff from 1 s toward --poll-interval, capped at
// 10 s, with jitter. Retry-After on 429 is honoured absolutely. On
// --wait-timeout: exit 10 and ALWAYS print the resume command.
import { ApiError, CliError, EXIT } from "../api/errors.js";
import type { Context } from "../config/resolve.js";
import * as v1 from "../api/v1.js";
import * as v2 from "../api/v2.js";
import { startProgress } from "../output/progress.js";
import { formatDurationMs, sleep } from "./duration.js";
import { detectIdKind } from "./ids.js";

export interface WaitOptions {
  /** Steady-state poll interval, seconds (default 3). */
  pollIntervalSec?: number;
  /** Total wait budget, ms (default 15 minutes). */
  waitTimeoutMs?: number;
  /** Label for the progress line. */
  label?: string;
}

export interface WaitOutcome<T> {
  result: T;
  /** Terminal state interpreted for --exit-status. */
  failed: boolean;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;

async function pollLoop<T>(
  ctx: Context,
  opts: WaitOptions,
  resumeCommand: string,
  check: () => Promise<{ done: boolean; failed: boolean; describe: string; value: T }>,
): Promise<WaitOutcome<T>> {
  const pollIntervalMs = (opts.pollIntervalSec ?? 3) * 1000;
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + waitTimeoutMs;
  const progress = startProgress(opts.label ?? "waiting", {
    noProgress: ctx.opts.noProgress,
    jsonMode: ctx.opts.json === true || ctx.opts.jsonl === true,
  });
  let attempt = 0;
  try {
    for (;;) {
      let state;
      try {
        state = await check();
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          const waitMs = (e.rateLimit?.retryAfterSeconds ?? 10) * 1000;
          progress.update(`rate limited; retrying in ${formatDurationMs(waitMs)}`);
          await sleep(waitMs);
          continue;
        }
        throw e;
      }
      if (state.done) {
        progress.stop();
        return { result: state.value, failed: state.failed };
      }
      progress.update(state.describe);
      if (Date.now() >= deadline) {
        progress.fail();
        throw new CliError(`gave up waiting after ${formatDurationMs(waitTimeoutMs)}`, {
          exitCode: EXIT.NETWORK,
          details: ["the job is still running server-side; nothing was cancelled"],
          help: [`resume with: ${resumeCommand}`, "or raise --wait-timeout"],
        });
      }
      // Exponential ramp 1s -> pollInterval, capped at 10s, with jitter.
      const base = Math.min(Math.min(1000 * 2 ** attempt, pollIntervalMs), 10_000);
      const delay = Math.max(250, base / 2 + Math.random() * (base / 2));
      attempt += 1;
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())) || 250);
    }
  } catch (e) {
    progress.fail();
    throw e;
  }
}

export function waitForV1Job(ctx: Context, jobId: string, opts: WaitOptions = {}): Promise<WaitOutcome<v1.JobStatus>> {
  return pollLoop(ctx, { label: `job ${jobId}`, ...opts }, `enconvert jobs wait ${jobId}`, async () => {
    const status = await v1.getJobStatus(ctx, jobId);
    return {
      done: status.status !== "processing",
      failed: status.status === "failed",
      describe: `job ${jobId}: ${status.status}`,
      value: status,
    };
  });
}

export function waitForV1Batch(ctx: Context, batchId: string, opts: WaitOptions = {}): Promise<WaitOutcome<v1.BatchStatus>> {
  return pollLoop(ctx, { label: `batch ${batchId}`, ...opts }, `enconvert jobs wait ${batchId}`, async () => {
    const status = await v1.getBatchStatus(ctx, batchId);
    const done = status.status !== "processing";
    return {
      done,
      failed: status.status === "failed",
      describe: `batch ${batchId}: ${status.completed}/${status.total} done, ${status.failed} failed`,
      value: status,
    };
  });
}

export function waitForPerceiveBatch(
  ctx: Context,
  jobId: string,
  opts: WaitOptions = {},
): Promise<WaitOutcome<v2.PerceiveBatchResponse>> {
  return pollLoop(ctx, { label: `perceive batch ${jobId}`, ...opts }, `enconvert jobs wait ${jobId}`, async () => {
    const batch = await v2.perceiveBatchGet(ctx, jobId);
    const done = !["queued", "processing"].includes(batch.status);
    return {
      done,
      failed: batch.status === "failed",
      describe: `batch ${jobId}: ${batch.completed ?? 0}/${batch.total ?? "?"} done`,
      value: batch,
    };
  });
}

export function waitForPerceiveOp(
  ctx: Context,
  operationId: string,
  opts: WaitOptions = {},
): Promise<WaitOutcome<v2.PerceiveResponse>> {
  return pollLoop(ctx, { label: `perceive ${operationId}`, ...opts }, `enconvert jobs wait ${operationId}`, async () => {
    const op = await v2.perceiveGet(ctx, operationId);
    const done = !["queued", "processing"].includes(op.status);
    return { done, failed: op.status === "failed", describe: `perceive ${operationId}: ${op.status}`, value: op };
  });
}

export function waitForIngest(
  ctx: Context,
  jobId: string,
  opts: WaitOptions = {},
): Promise<WaitOutcome<v2.IngestJobResponse>> {
  return pollLoop(ctx, { label: `ingest ${jobId}`, ...opts }, `enconvert jobs wait ${jobId}`, async () => {
    const job = await v2.ingestGet(ctx, jobId);
    const done = !["queued", "discovering", "processing"].includes(job.status);
    return {
      done,
      failed: job.status === "failed",
      describe: `ingest ${jobId}: ${job.status} (${job.pages_processed ?? 0}/${job.pages_discovered ?? "?"} pages, ${job.total_chunks ?? 0} chunks)`,
      value: job,
    };
  });
}

/**
 * `enconvert jobs wait <id>` — route on the id prefix. batch_ is ambiguous
 * between v2 perceive batches and v1 url batches: poll v2 first, fall back on 404.
 */
export async function waitForAnyId(
  ctx: Context,
  id: string,
  opts: WaitOptions = {},
): Promise<WaitOutcome<unknown>> {
  const kind = detectIdKind(id);
  if (kind === "ingest") return waitForIngest(ctx, id, opts);
  if (kind === "perceive") return waitForPerceiveOp(ctx, id, opts);
  if (kind === "distill") {
    throw new CliError(`distill operations are synchronous; there is nothing to poll for ${id}`, {
      exitCode: EXIT.USAGE,
    });
  }
  if (kind === "watch") {
    throw new CliError(`watchers are managed at https://enconvert.com/dashboard (not in the CLI yet)`, {
      exitCode: EXIT.USAGE,
    });
  }
  if (kind === "batch") {
    try {
      return await waitForPerceiveBatch(ctx, id, opts);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return waitForV1Batch(ctx, id, opts);
      }
      throw e;
    }
  }
  return waitForV1Job(ctx, id, opts);
}
