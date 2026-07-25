// Error hierarchy, gateway error-envelope parsing, and status -> exit-code mapping.
//
// Exit codes are a published, append-only contract (`enconvert help exit-codes`).

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  INPUT_NOT_FOUND: 3,
  AUTH: 4,
  RATE_LIMITED: 5,
  PLAN_GATE: 6,
  UNSUPPORTED: 7,
  INPUT_REJECTED: 8,
  SERVER_FAILURE: 9,
  NETWORK: 10,
  SIGINT: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** error[EXXX] identifiers map 1:1 onto exit codes 1-10. */
export function errorId(exitCode: number): string {
  if (exitCode >= 1 && exitCode <= 10) {
    return `E${String(exitCode).padStart(3, "0")}`;
  }
  return "E001";
}

export interface CliErrorOptions {
  exitCode?: number;
  /** Indented explanation lines under the headline. */
  details?: string[];
  /** `help:` suggestion lines. */
  help?: string[];
  /** Docs URL; defaults to the per-error-code docs page. */
  docs?: string;
  cause?: unknown;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly id: string;
  readonly details: string[];
  readonly helpLines: string[];
  readonly docs: string | undefined;

  constructor(message: string, opts: CliErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CliError";
    this.exitCode = opts.exitCode ?? EXIT.GENERIC;
    this.id = errorId(this.exitCode);
    this.details = opts.details ?? [];
    this.helpLines = opts.help ?? [];
    this.docs =
      opts.docs ??
      (this.exitCode >= 1 && this.exitCode <= 10
        ? `https://enconvert.com/docs/errors/${this.id}`
        : undefined);
  }
}

export function usageError(message: string, opts: Omit<CliErrorOptions, "exitCode"> = {}): CliError {
  return new CliError(message, { ...opts, exitCode: EXIT.USAGE });
}

export function inputNotFoundError(message: string, opts: Omit<CliErrorOptions, "exitCode"> = {}): CliError {
  return new CliError(message, { ...opts, exitCode: EXIT.INPUT_NOT_FOUND });
}

export function networkError(message: string, opts: Omit<CliErrorOptions, "exitCode"> = {}): CliError {
  return new CliError(message, { ...opts, exitCode: EXIT.NETWORK });
}

export function unsupportedError(message: string, opts: Omit<CliErrorOptions, "exitCode"> = {}): CliError {
  return new CliError(message, { ...opts, exitCode: EXIT.UNSUPPORTED });
}

/** Map an HTTP status from the gateway to a documented exit code. */
export function statusToExitCode(status: number): number {
  if (status === 401) return EXIT.AUTH;
  if (status === 402 || status === 403) return EXIT.PLAN_GATE;
  if (status === 413) return EXIT.INPUT_REJECTED;
  if (status === 415) return EXIT.UNSUPPORTED;
  if (status === 422) return EXIT.USAGE;
  if (status === 429) return EXIT.RATE_LIMITED;
  if (status === 408 || status === 504) return EXIT.NETWORK;
  if (status >= 500) return EXIT.SERVER_FAILURE;
  if (status === 400) return EXIT.INPUT_REJECTED;
  return EXIT.GENERIC;
}

export interface RateLimitInfo {
  limit?: string;
  remaining?: string;
  reset?: string;
  retryAfterSeconds?: number;
}

export class ApiError extends CliError {
  readonly status: number;
  /** Machine code from a ConversionError envelope (e.g. "upstream_timeout"). */
  readonly code: string | undefined;
  /** Raw parsed response body, for --json / --debug consumers. */
  readonly body: unknown;
  readonly rateLimit: RateLimitInfo | undefined;

  constructor(
    message: string,
    status: number,
    opts: CliErrorOptions & { code?: string; body?: unknown; rateLimit?: RateLimitInfo } = {},
  ) {
    super(message, { exitCode: statusToExitCode(status), ...opts });
    this.name = "ApiError";
    this.status = status;
    this.code = opts.code;
    this.body = opts.body;
    this.rateLimit = opts.rateLimit;
  }
}

interface ValidationItem {
  loc?: unknown[];
  msg?: string;
  type?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readRateLimit(headers: Headers): RateLimitInfo | undefined {
  const limit = headers.get("ratelimit-limit") ?? undefined;
  const remaining = headers.get("ratelimit-remaining") ?? undefined;
  const reset = headers.get("ratelimit-reset") ?? undefined;
  const retryAfterRaw = headers.get("retry-after");
  const retryAfterSeconds =
    retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw.trim())
      ? Number(retryAfterRaw.trim())
      : undefined;
  if (limit === undefined && remaining === undefined && reset === undefined && retryAfterSeconds === undefined) {
    return undefined;
  }
  return { limit, remaining, reset, retryAfterSeconds };
}

/**
 * Parse the gateway's five distinct error envelopes into a single ApiError:
 *  1. {"detail": "<string>"}                              - HTTPException
 *  2. {"detail": {error, file_size, max_size, tier, ...}} - 413 validate_file_size
 *  3. {"detail": [{loc, msg, type}, ...]}                 - Pydantic 422
 *  4. {"error", "code", "detail", "upstream_status"}      - ConversionError
 *  5. {"error": "Internal server error", "event_id": ...} - unhandled 500
 */
export function parseApiError(status: number, body: unknown, headers: Headers): ApiError {
  const rateLimit = readRateLimit(headers);
  const details: string[] = [];
  const help: string[] = [];
  let message = `request failed with HTTP ${status}`;
  let code: string | undefined;

  if (isRecord(body)) {
    const detail = body["detail"];
    if (typeof detail === "string") {
      message = detail;
    } else if (Array.isArray(detail)) {
      message = "the request body failed validation";
      for (const raw of detail.slice(0, 12)) {
        const item = raw as ValidationItem;
        const loc = Array.isArray(item.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
        details.push(loc !== "" ? `${loc}: ${item.msg ?? "invalid"}` : String(item.msg ?? "invalid"));
      }
      if (detail.length > 12) details.push(`... and ${detail.length - 12} more`);
    } else if (isRecord(detail)) {
      message = typeof detail["error"] === "string" ? (detail["error"] as string) : message;
      if (detail["file_size"] !== undefined && detail["max_size"] !== undefined) {
        details.push(`file size ${formatBytes(Number(detail["file_size"]))}, plan limit ${formatBytes(Number(detail["max_size"]))}`);
      }
      if (typeof detail["tier"] === "string") details.push(`plan tier: ${detail["tier"]}`);
      if (typeof detail["key_type"] === "string") details.push(`key type: ${detail["key_type"]}`);
    } else if (typeof body["error"] === "string") {
      message = body["error"] as string;
      if (typeof body["code"] === "string") code = body["code"] as string;
      if (typeof body["detail"] === "string" && body["detail"] !== message) {
        details.push(body["detail"] as string);
      }
      if (body["upstream_status"] !== undefined && body["upstream_status"] !== null) {
        details.push(`upstream status: ${String(body["upstream_status"])}`);
      }
      if (body["event_id"] !== undefined && body["event_id"] !== null) {
        details.push(`event id: ${String(body["event_id"])} (share this with support@enconvert.com)`);
      }
    }
  } else if (typeof body === "string" && body.trim() !== "") {
    message = body.trim().slice(0, 300);
  }

  if (status === 401) {
    help.push("run `enconvert auth login`, or set ENCONVERT_API_KEY", "check `enconvert auth status` to see which credential is being used");
  } else if (status === 402) {
    help.push("upgrade at https://enconvert.com/pricing", "or run `enconvert usage --json` for the breakdown");
  } else if (status === 403) {
    help.push("this feature may not be included in your plan, or you may be using a public pk_ key where a private sk_ key is required");
  } else if (status === 429) {
    if (rateLimit?.retryAfterSeconds !== undefined) {
      details.push(`retry after ${rateLimit.retryAfterSeconds}s`);
    }
    if (rateLimit?.limit !== undefined) {
      details.push(`rate limit: ${rateLimit.remaining ?? "?"}/${rateLimit.limit} remaining`);
    }
  } else if (status === 504) {
    help.push("the conversion timed out server-side; retry, or reduce the input size");
  }

  return new ApiError(message, status, { code, body, rateLimit, details, help });
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
