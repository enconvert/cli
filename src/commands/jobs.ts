// Job/batch inspection (`jobs get|batch|wait`) and stored-object download
// (`files download`). `jobs wait` is the composable half of every --no-wait
// flow: it auto-detects the id kind (ing_/per_/batch_/bare v1 job id) and
// routes to the right poll endpoint.
import { basename } from "node:path";
import type { Command } from "commander";
import { EXIT, formatBytes } from "../api/errors.js";
import * as v1 from "../api/v1.js";
import type { Context } from "../config/resolve.js";
import { info, out, outBytes, verbose, warn } from "../output/streams.js";
import { renderTable } from "../output/table.js";
import { addWaitOptions, contextFor } from "../program.js";
import { atomicWriteFile, sanitizeFilename, toAbsolute } from "../util/files.js";
import { waitForAnyId } from "../util/poll.js";
import { emitJson, resolveArtifactPath, waitOptionsFrom } from "./_shared.js";

interface WaitCliOpts {
  wait?: boolean;
  pollInterval?: number;
  waitTimeout?: string;
  exitStatus?: boolean;
  urlOnly?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort download URL across the v1/v2 terminal-result shapes. */
function finalUrlOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of ["presigned_url", "zip_download_url", "output_url"]) {
    const value = result[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const zip = result["zip"];
  if (isRecord(zip) && typeof zip["url"] === "string" && zip["url"] !== "") {
    return zip["url"];
  }
  return undefined;
}

function summarize(id: string, result: unknown, failed: boolean): string {
  const status = isRecord(result) && typeof result["status"] === "string"
    ? result["status"]
    : failed
      ? "failed"
      : "done";
  const counts: string[] = [];
  if (isRecord(result)) {
    if (typeof result["completed"] === "number" && typeof result["total"] === "number") {
      counts.push(`${result["completed"]}/${result["total"]} done`);
    }
    if (typeof result["failed"] === "number" && result["failed"] > 0) {
      counts.push(`${result["failed"]} failed`);
    }
  }
  return counts.length > 0 ? `${id}: ${status} (${counts.join(", ")})` : `${id}: ${status}`;
}

function batchItemRows(batch: v1.BatchStatus): string[][] {
  return batch.items.map((item) => [
    item.source_url,
    item.status,
    item.output_file_size !== undefined ? formatBytes(item.output_file_size) : "-",
    item.duration !== undefined ? `${item.duration}s` : "-",
  ]);
}

async function runFilesDownload(ctx: Context, objectKey: string, opts: { output?: string }): Promise<void> {
  const { bytes, headers } = await v1.downloadObjectBytes(ctx, objectKey);
  if (opts.output === "-") {
    outBytes(bytes);
    return;
  }
  // The gateway names the file via X-Filename; fall back to the key's basename.
  const headerName = headers.get("x-filename");
  const derived = sanitizeFilename(headerName !== null && headerName !== "" ? headerName : basename(objectKey));
  const dest = resolveArtifactPath(ctx, opts.output !== undefined ? { output: opts.output } : {}, derived);
  if (dest === null) {
    verbose(`skipping ${objectKey}: output exists (--skip-existing)`);
    return;
  }
  atomicWriteFile(dest, bytes);
  out(toAbsolute(dest));
}

export function registerJobsCommands(program: Command): void {
  const jobs = program.command("jobs").description("inspect and wait on conversion jobs and batches");

  jobs
    .command("get <job_id>")
    .description("fetch a v1 conversion job's status (GET /v1/convert/status/{id})")
    .addHelpText("after", "\nExamples:\n  enconvert jobs get 4f1c9a…\n  enconvert jobs get 4f1c9a… --json")
    .action(async (jobId: string, _opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const status = await v1.getJobStatus(ctx, jobId);
      if (emitJson(ctx, status)) return;
      info(`job ${jobId}: ${status.status}`);
      if (status.status === "success" && status.presigned_url !== undefined && status.presigned_url !== "") {
        out(status.presigned_url);
      }
      if (status.status === "failed") {
        warn(status.error ?? "conversion failed (no error detail)");
      }
    });

  jobs
    .command("batch <batch_id>")
    .description("fetch a v1 batch's status and per-item results (GET /v1/convert/batch/{id})")
    .addHelpText("after", "\nExamples:\n  enconvert jobs batch batch_ab12…\n  enconvert jobs batch batch_ab12… --json")
    .action(async (batchId: string, _opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const batch = await v1.getBatchStatus(ctx, batchId);
      if (emitJson(ctx, batch)) return;
      out(
        `batch ${batch.batch_id}: ${batch.status} (${batch.completed}/${batch.total} done, ${batch.failed} failed, ${batch.in_progress} running, output ${batch.output_mode})`,
      );
      if (batch.zip_download_url !== undefined && batch.zip_download_url !== "") {
        out(`zip: ${batch.zip_download_url}`);
      }
      if (batch.items.length > 0) {
        out(renderTable(batchItemRows(batch), { header: ["url", "status", "size", "duration"], rightAlign: [2, 3] }));
      }
    });

  const wait = jobs
    .command("wait <id>")
    .description("block until a job or batch finishes (auto-detects ing_/per_/batch_/v1 ids)");
  addWaitOptions(wait);
  wait
    .addHelpText(
      "after",
      `
Examples:
  enconvert jobs wait batch_ab12… --poll-interval 5 --wait-timeout 30m
  enconvert jobs wait ing_cd34… --exit-status
  enconvert ingest create https://x.com --no-wait --json | jq -r .job_id | xargs enconvert jobs wait`,
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const opts = cmd.opts<WaitCliOpts>();
      const outcome = await waitForAnyId(ctx, id, waitOptionsFrom(opts));
      if (opts.exitStatus === true && outcome.failed) process.exitCode = EXIT.SERVER_FAILURE;
      if (emitJson(ctx, outcome.result)) return;
      const url = finalUrlOf(outcome.result);
      if (opts.urlOnly === true) {
        if (url !== undefined) out(url);
        else warn("the final result has no download URL");
        return;
      }
      info(summarize(id, outcome.result, outcome.failed));
      if (url !== undefined) out(url);
    });

  const files = program.command("files").description("work with stored conversion outputs");
  files
    .command("download <object-key>")
    .description("download a stored object's bytes (GET /v1/convert/download/{key})")
    .option("-o, --output <path>", 'output file, or "-" for bytes on stdout')
    .addHelpText(
      "after",
      "\nExamples:\n  enconvert files download prod/files/proj_1/report.pdf\n  enconvert files download prod/files/proj_1/report.pdf -o - | wc -c",
    )
    .action(async (objectKey: string, _opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      await runFilesDownload(ctx, objectKey, cmd.opts<{ output?: string }>());
    });
}
