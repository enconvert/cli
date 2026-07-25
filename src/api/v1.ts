// Every /v1 route, raw snake_case JSON in/out. Thin: zero conversion logic,
// zero renaming — `--json` must emit the gateway's response verbatim.
import type { Context } from "../config/resolve.js";
import { newJobId } from "../util/ids.js";
import { buildUploadForm, type UploadFieldValues } from "./multipart.js";
import { apiRequest, postWithJobFallback } from "./http.js";
import { ApiError, CliError, EXIT } from "./errors.js";
import { sleep } from "../util/duration.js";

export interface SyncEnvelope {
  presigned_url: string;
  object_key: string;
  filename: string;
  file_size: number;
  conversion_time_seconds: number;
  job_id?: string | null;
  [k: string]: unknown;
}

export interface AsyncAccepted {
  status: string;
  batch_id: string;
  url_count: number;
  output_format: string;
  total_discovered?: number;
  discovery_method?: string;
  [k: string]: unknown;
}

export interface JobStatus {
  status: "processing" | "success" | "failed";
  presigned_url?: string;
  object_key?: string;
  error?: string;
  [k: string]: unknown;
}

export interface BatchItem {
  source_url: string;
  status: string;
  download_url?: string;
  output_file_size?: number;
  duration?: number;
  [k: string]: unknown;
}

export interface BatchStatus {
  batch_id: string;
  status: "processing" | "completed" | "partial" | "failed";
  total: number;
  completed: number;
  failed: number;
  in_progress: number;
  output_mode: "zip" | "individual";
  zip_download_url?: string;
  items: BatchItem[];
  [k: string]: unknown;
}

export async function whoami(ctx: Context): Promise<{ project_id: string; plan_slug: string }> {
  const res = await apiRequest(ctx, { path: "/v1/whoami" });
  return res.json as { project_id: string; plan_slug: string };
}

export async function authVerify(ctx: Context): Promise<Record<string, unknown>> {
  const res = await apiRequest(ctx, { path: "/v1/auth/verify" });
  return res.json as Record<string, unknown>;
}

export async function health(ctx: Context): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await apiRequest(ctx, { path: "/health", anonymous: true, allowErrorResponse: true });
  return { status: res.status, body: (res.json ?? {}) as Record<string, unknown> };
}

export async function apiRoot(ctx: Context): Promise<Record<string, unknown>> {
  const res = await apiRequest(ctx, { path: "/", anonymous: true });
  return res.json as Record<string, unknown>;
}

export async function getJobStatus(ctx: Context, jobId: string): Promise<JobStatus> {
  const res = await apiRequest(ctx, { path: `/v1/convert/status/${encodeURIComponent(jobId)}` });
  return res.json as JobStatus;
}

export async function getBatchStatus(ctx: Context, batchId: string): Promise<BatchStatus> {
  const res = await apiRequest(ctx, { path: `/v1/convert/batch/${encodeURIComponent(batchId)}` });
  return res.json as BatchStatus;
}

/**
 * Fallback poller used when a job-producing POST dies with a 5xx
 * (ported from node-sdk client.ts postJson).
 */
async function pollJobUntilDone(ctx: Context, jobId: string, maxWaitMs = 300_000): Promise<SyncEnvelope> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    let status: JobStatus;
    try {
      status = await getJobStatus(ctx, jobId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue; // job row not visible yet
      throw e;
    }
    if (status.status === "success") {
      return {
        presigned_url: status.presigned_url ?? "",
        object_key: status.object_key ?? "",
        filename: "",
        file_size: 0,
        conversion_time_seconds: 0,
        job_id: jobId,
      };
    }
    if (status.status === "failed") {
      throw new CliError(status.error ?? "conversion failed", { exitCode: EXIT.SERVER_FAILURE });
    }
  }
  throw new CliError(`conversion still running after ${Math.round(maxWaitMs / 1000)}s`, {
    exitCode: EXIT.NETWORK,
    help: [`resume with: enconvert jobs wait ${jobId}`],
  });
}

/** POST a multipart conversion. Response is ALWAYS the JSON envelope. */
export async function uploadConvert(
  ctx: Context,
  endpoint: string,
  filePath: string,
  fields: UploadFieldValues = {},
): Promise<SyncEnvelope> {
  const jobId = fields["job_id"] ?? newJobId();
  const { form } = await buildUploadForm(filePath, {
    ...fields,
    direct_download: "false",
    job_id: jobId,
  });
  const result = await postWithJobFallback(
    ctx,
    // Conversions can be slow; give a single upload the server's own budget.
    { method: "POST", path: endpoint, form, timeoutMs: Math.max(ctx.timeoutMs, 300_000) },
    jobId,
    (id) => pollJobUntilDone(ctx, id),
  );
  return { job_id: jobId, ...(result as SyncEnvelope) };
}

export type UrlConvertResult =
  | { kind: "sync"; envelope: SyncEnvelope }
  | { kind: "accepted"; accepted: AsyncAccepted }
  | { kind: "bytes"; bytes: Uint8Array; headers: Headers };

/** POST /v1/convert/url-to-{pdf,screenshot,markdown}. */
export async function urlConvert(
  ctx: Context,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<UrlConvertResult> {
  const jobId = (body["job_id"] as string | undefined) ?? newJobId();
  const payload = { ...body, job_id: jobId };
  let res;
  try {
    res = await apiRequest(ctx, {
      method: "POST",
      path: endpoint,
      jsonBody: payload,
      timeoutMs: Math.max(ctx.timeoutMs, 300_000),
    });
  } catch (e) {
    if (e instanceof ApiError && e.status >= 500 && body["async_mode"] !== true) {
      const envelope = await pollJobUntilDone(ctx, jobId);
      return { kind: "sync", envelope };
    }
    throw e;
  }
  if (res.status === 202) {
    return { kind: "accepted", accepted: res.json as AsyncAccepted };
  }
  if (res.bytes !== undefined) {
    return { kind: "bytes", bytes: res.bytes, headers: res.headers };
  }
  return { kind: "sync", envelope: { job_id: jobId, ...(res.json as SyncEnvelope) } };
}

/** POST /v1/convert/website-to-{pdf,screenshot}: always 202. */
export async function websiteConvert(
  ctx: Context,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<AsyncAccepted> {
  // No job fallback: website submissions have no per-job row; a 5xx means the
  // submission itself failed (same rule as node-sdk).
  const res = await apiRequest(ctx, {
    method: "POST",
    path: endpoint,
    jsonBody: body,
    timeoutMs: Math.max(ctx.timeoutMs, 300_000),
  });
  return res.json as AsyncAccepted;
}

/** GET /v1/convert/download/{object_key}: streams the object's bytes. */
export async function downloadObjectBytes(ctx: Context, objectKey: string): Promise<{ bytes: Uint8Array; headers: Headers }> {
  const res = await apiRequest(ctx, {
    path: `/v1/convert/download/${objectKey.split("/").map(encodeURIComponent).join("/")}`,
  });
  if (res.bytes === undefined) {
    // JSON error came back 200? Defensive: treat as failure.
    throw new CliError("download returned no bytes", { exitCode: EXIT.SERVER_FAILURE });
  }
  return { bytes: res.bytes, headers: res.headers };
}
