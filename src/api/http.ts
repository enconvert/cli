// The fetch core. Every request to the gateway goes through apiRequest():
//   - X-API-Key auth (never Authorization: Bearer, never an Origin header)
//   - User-Agent enconvert-cli/x.y.z
//   - per-request timeout (--timeout, default 120s)
//   - retries for idempotent requests only, honouring Retry-After
//   - --debug HTTP tracing on stderr with the key redacted
import { redactKey } from "../config/credentials.js";
import type { Context } from "../config/resolve.js";
import { debug } from "../output/streams.js";
import { sleep } from "../util/duration.js";
import { VERSION, USER_AGENT } from "../version.js";
import { ApiError, CliError, EXIT, networkError, parseApiError } from "./errors.js";

export interface ApiRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body; serialized with content-type application/json. */
  jsonBody?: unknown;
  /** Multipart body; content-type set by fetch/undici. */
  form?: FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Max retry attempts for idempotent requests (GET/HEAD only). */
  retries?: number;
  /** Do not require an API key (e.g. GET /health). */
  anonymous?: boolean;
  /** Return the 2xx body as raw bytes even when it is JSON (direct_download artifacts). */
  rawBody?: boolean;
  /** Return the error response instead of throwing (for `enconvert api -i`). */
  allowErrorResponse?: boolean;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body when the response is JSON. */
  json: unknown | undefined;
  /** Raw bytes when the response is not JSON (direct_download streams). */
  bytes: Uint8Array | undefined;
  durationMs: number;
}

function buildUrl(base: string, path: string, query?: ApiRequestOptions["query"]): string {
  const url = new URL(base + (path.startsWith("/") ? path : `/${path}`));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function isIdempotent(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export async function apiRequest(ctx: Context, opts: ApiRequestOptions): Promise<ApiResponse> {
  const method = (opts.method ?? (opts.jsonBody !== undefined || opts.form !== undefined ? "POST" : "GET")).toUpperCase();
  const url = buildUrl(ctx.apiUrl, opts.path, opts.query);
  const timeoutMs = opts.timeoutMs ?? ctx.timeoutMs;
  const maxRetries = isIdempotent(method) ? (opts.retries ?? ctx.retries) : 0;

  const headers: Record<string, string> = {
    "user-agent": `${USER_AGENT}`,
    accept: "application/json, */*",
    ...opts.headers,
  };
  if (!opts.anonymous) {
    headers["x-api-key"] = ctx.apiKey();
  }
  let body: string | FormData | undefined;
  if (opts.jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.jsonBody);
  } else if (opts.form !== undefined) {
    body = opts.form;
  }

  let attempt = 0;
  for (;;) {
    const started = Date.now();
    if (ctx.opts.debug) {
      const keyNote = headers["x-api-key"] !== undefined ? ` key=${redactKey(headers["x-api-key"])}` : "";
      debug(`> ${method} ${url}${keyNote}${attempt > 0 ? ` (retry ${attempt}/${maxRetries})` : ""}`);
      if (opts.jsonBody !== undefined) debug(`> body ${JSON.stringify(opts.jsonBody).slice(0, 2000)}`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
    } catch (e) {
      const cause = e instanceof Error ? e : new Error(String(e));
      const timedOut = cause.name === "TimeoutError" || cause.name === "AbortError";
      if (attempt < maxRetries) {
        attempt += 1;
        const delay = Math.random() * Math.min(500 * 2 ** attempt, 4000);
        debug(`network error (${cause.message}); retrying in ${Math.round(delay)}ms`);
        await sleep(delay);
        continue;
      }
      if (timedOut) {
        throw networkError(`request timed out after ${Math.round(timeoutMs / 1000)}s: ${method} ${opts.path}`, {
          help: ["raise --timeout for slow conversions (this is the per-request limit, not --wait-timeout)"],
          cause,
        });
      }
      throw networkError(`could not reach ${new URL(url).host}`, {
        details: [cause.message],
        help: ["check your network, proxy settings, and --api-url"],
        cause,
      });
    }

    const durationMs = Date.now() - started;
    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");
    if (ctx.opts.debug) debug(`< ${response.status} ${contentType} (${durationMs}ms)`);

    // Retry idempotent requests on 429/503 with Retry-After.
    if ((response.status === 429 || response.status === 503) && attempt < maxRetries && isIdempotent(method)) {
      const retryAfterRaw = response.headers.get("retry-after");
      const retryAfterMs =
        retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw.trim())
          ? Number(retryAfterRaw.trim()) * 1000
          : Math.min(1000 * 2 ** (attempt + 1), 10_000);
      attempt += 1;
      await response.body?.cancel();
      debug(`HTTP ${response.status}; retrying in ${retryAfterMs}ms (Retry-After honoured)`);
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status >= 400) {
      let parsedBody: unknown;
      if (isJson) {
        try {
          parsedBody = await response.json();
        } catch {
          parsedBody = undefined;
        }
      } else {
        parsedBody = await response.text().catch(() => undefined);
      }
      const apiError = parseApiError(response.status, parsedBody, response.headers);
      if (opts.allowErrorResponse) {
        return {
          status: response.status,
          headers: response.headers,
          json: isJson ? parsedBody : undefined,
          bytes: isJson ? undefined : new TextEncoder().encode(typeof parsedBody === "string" ? parsedBody : ""),
          durationMs,
        };
      }
      throw apiError;
    }

    if (isJson && opts.rawBody !== true) {
      const json: unknown = await response.json();
      return { status: response.status, headers: response.headers, json, bytes: undefined, durationMs };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, json: undefined, bytes, durationMs };
  }
}

/**
 * The SDK's crash-recovery pattern: on a 5xx from a job-producing POST,
 * switch to polling the client-generated job_id instead of retrying the POST.
 */
export async function postWithJobFallback(
  ctx: Context,
  opts: ApiRequestOptions,
  jobId: string,
  pollFn: (jobId: string) => Promise<unknown>,
): Promise<unknown> {
  try {
    const response = await apiRequest(ctx, opts);
    return response.json;
  } catch (e) {
    if (e instanceof ApiError && e.status >= 500) {
      debug(`POST failed with ${e.status}; falling back to polling job ${jobId}`);
      return pollFn(jobId);
    }
    throw e;
  }
}

export { VERSION };

export function assertNever(x: never): never {
  throw new CliError(`internal error: unexpected value ${String(x)}`, { exitCode: EXIT.GENERIC });
}
