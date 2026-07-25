// Every /v2 route (minus watch), raw snake_case JSON in/out.
// Request bodies are transcribed from api/gateway/api/v2/schemas/*.py — the CLI
// sends exactly what the user asked for and never renames fields.
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Context } from "../config/resolve.js";
import { statInput } from "../util/files.js";
import { apiRequest } from "./http.js";

export interface OutputArtifact {
  url?: string;
  object_key?: string;
  size_bytes?: number;
  content_type?: string;
  expires_in?: number;
  [k: string]: unknown;
}

export interface PerceiveResponse {
  operation_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  url: string;
  url_final?: string;
  content_hash?: string;
  render_quality?: number;
  cache_hit?: boolean;
  outputs?: Record<string, OutputArtifact>;
  structured?: unknown;
  extraction_tier?: string;
  tokens?: { input: number; output: number };
  cost_cents?: number;
  duration_ms?: number;
  error?: string;
  warnings?: string[];
  [k: string]: unknown;
}

export interface PerceiveBatchResponse {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed" | "partial" | "canceled";
  output_mode?: string;
  total?: number;
  completed?: number;
  failed?: number;
  pending?: number;
  zip?: OutputArtifact;
  items?: PerceiveResponse[];
  warnings?: string[];
  [k: string]: unknown;
}

export interface DiscoverResponse {
  url: string;
  mode: string;
  total: number;
  urls: string[];
  pages_crawled?: number;
  truncated?: boolean;
  robots_respected?: boolean;
  sources?: Record<string, number>;
  warnings?: string[];
  [k: string]: unknown;
}

export interface LookupResult {
  title?: string;
  url?: string;
  snippet?: string;
  position?: number;
  perceive?: PerceiveResponse;
  [k: string]: unknown;
}

export interface LookupResponse {
  query: string;
  category: string;
  total?: number;
  results: LookupResult[];
  perceive_top?: number;
  perceive_operation_ids?: string[];
  answer?: string;
  answer_sources?: string[];
  answer_box?: unknown;
  knowledge_graph?: unknown;
  cost_cents?: number;
  warnings?: string[];
  [k: string]: unknown;
}

export interface DistillItemResult {
  url: string;
  url_final?: string;
  status: "completed" | "failed";
  data?: unknown;
  extraction_tier?: string;
  fields_from_css?: number;
  fields_from_llm?: number;
  error?: string;
  warnings?: string[];
  [k: string]: unknown;
}

export interface DistillResponse {
  operation_id: string;
  total: number;
  completed: number;
  failed: number;
  results: DistillItemResult[];
  total_cost_cents?: number;
  synthesized_schema?: unknown;
  warnings?: string[];
  [k: string]: unknown;
}

export interface IngestJobResponse {
  job_id: string;
  status: "queued" | "discovering" | "processing" | "completed" | "failed" | "canceled";
  mode?: string;
  pages_discovered?: number;
  pages_processed?: number;
  pages_failed?: number;
  total_chunks?: number;
  output_url?: string;
  error_message?: string;
  webhook_url?: string;
  webhook_delivered?: boolean;
  created_at?: string;
  completed_at?: string;
  warnings?: string[];
  [k: string]: unknown;
}

export interface IngestJobListResponse {
  jobs: Array<IngestJobResponse & { webhook_configured?: boolean }>;
  skip: number;
  limit: number;
  has_more: boolean;
  [k: string]: unknown;
}

export interface WebhookSecretResponse {
  secret: string;
  signature_header: string;
  timestamp_header: string;
  signature_scheme: string;
  replay_tolerance_seconds: number;
  rotated: boolean;
  [k: string]: unknown;
}

export interface WebhookRetryResponse {
  job_id: string;
  delivered: boolean;
  attempts: number;
  status_code?: number;
  detail: string;
  [k: string]: unknown;
}

const V2_TIMEOUT_FLOOR_MS = 300_000; // v2 renders can be slow; match the server budget

async function postV2<T>(ctx: Context, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await apiRequest(ctx, {
    method: "POST",
    path,
    jsonBody: body,
    timeoutMs: Math.max(ctx.timeoutMs, V2_TIMEOUT_FLOOR_MS),
  });
  return res.json as T;
}

export function perceive(ctx: Context, body: Record<string, unknown>): Promise<PerceiveResponse> {
  return postV2(ctx, "/v2/perceive", body);
}

export async function perceiveGet(ctx: Context, operationId: string): Promise<PerceiveResponse> {
  const res = await apiRequest(ctx, { path: `/v2/perceive/${encodeURIComponent(operationId)}` });
  return res.json as PerceiveResponse;
}

/** 200 (finished inline) or 202 (queued) — branch on status, not URL count. */
export async function perceiveBatch(
  ctx: Context,
  body: Record<string, unknown>,
): Promise<{ status: number; batch: PerceiveBatchResponse }> {
  const res = await apiRequest(ctx, {
    method: "POST",
    path: "/v2/perceive/batch",
    jsonBody: body,
    timeoutMs: Math.max(ctx.timeoutMs, V2_TIMEOUT_FLOOR_MS),
  });
  return { status: res.status, batch: res.json as PerceiveBatchResponse };
}

export async function perceiveBatchGet(ctx: Context, jobId: string): Promise<PerceiveBatchResponse> {
  const res = await apiRequest(ctx, { path: `/v2/perceive/batch/${encodeURIComponent(jobId)}` });
  return res.json as PerceiveBatchResponse;
}

export async function perceiveBatchCancel(ctx: Context, jobId: string): Promise<PerceiveBatchResponse> {
  const res = await apiRequest(ctx, {
    method: "DELETE",
    path: `/v2/perceive/batch/${encodeURIComponent(jobId)}`,
  });
  return res.json as PerceiveBatchResponse;
}

export function discover(ctx: Context, body: Record<string, unknown>): Promise<DiscoverResponse> {
  return postV2(ctx, "/v2/discover", body);
}

export function lookup(ctx: Context, body: Record<string, unknown>): Promise<LookupResponse> {
  return postV2(ctx, "/v2/lookup", body);
}

export function distill(ctx: Context, body: Record<string, unknown>): Promise<DistillResponse> {
  return postV2(ctx, "/v2/distill", body);
}

export function ingestCreate(ctx: Context, body: Record<string, unknown>): Promise<IngestJobResponse> {
  return postV2(ctx, "/v2/ingest", body);
}

export async function ingestFiles(
  ctx: Context,
  filePaths: string[],
  fields: { max_words?: number; sentence_overlap?: number; webhook_url?: string },
): Promise<IngestJobResponse> {
  const form = new FormData();
  for (const filePath of filePaths) {
    statInput(filePath);
    const blob = await openAsBlob(filePath);
    form.append("files", blob, basename(filePath));
  }
  if (fields.max_words !== undefined) form.append("max_words", String(fields.max_words));
  if (fields.sentence_overlap !== undefined) form.append("sentence_overlap", String(fields.sentence_overlap));
  if (fields.webhook_url !== undefined) form.append("webhook_url", fields.webhook_url);
  const res = await apiRequest(ctx, {
    method: "POST",
    path: "/v2/ingest/files",
    form,
    timeoutMs: Math.max(ctx.timeoutMs, V2_TIMEOUT_FLOOR_MS),
  });
  return res.json as IngestJobResponse;
}

export async function ingestList(
  ctx: Context,
  query: { skip?: number; limit?: number } = {},
): Promise<IngestJobListResponse> {
  const res = await apiRequest(ctx, { path: "/v2/ingest", query });
  return res.json as IngestJobListResponse;
}

export async function ingestGet(ctx: Context, jobId: string): Promise<IngestJobResponse> {
  const res = await apiRequest(ctx, { path: `/v2/ingest/${encodeURIComponent(jobId)}` });
  return res.json as IngestJobResponse;
}

export async function ingestCancel(ctx: Context, jobId: string): Promise<IngestJobResponse> {
  const res = await apiRequest(ctx, { method: "DELETE", path: `/v2/ingest/${encodeURIComponent(jobId)}` });
  return res.json as IngestJobResponse;
}

export async function ingestRetryWebhook(ctx: Context, jobId: string): Promise<WebhookRetryResponse> {
  const res = await apiRequest(ctx, {
    method: "POST",
    path: `/v2/ingest/${encodeURIComponent(jobId)}/retry-webhook`,
  });
  return res.json as WebhookRetryResponse;
}

export async function webhookSecretShow(ctx: Context): Promise<WebhookSecretResponse> {
  const res = await apiRequest(ctx, { path: "/v2/ingest/webhook-secret" });
  return res.json as WebhookSecretResponse;
}

export async function webhookSecretRotate(ctx: Context): Promise<WebhookSecretResponse> {
  const res = await apiRequest(ctx, { method: "POST", path: "/v2/ingest/webhook-secret/rotate" });
  return res.json as WebhookSecretResponse;
}
