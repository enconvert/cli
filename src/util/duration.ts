// Duration parsing/formatting. "300" (seconds), "300s", "5m", "1h30m", "250ms".
import { usageError } from "../api/errors.js";

export function parseDurationMs(input: string | number, flagName = "duration"): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw usageError(`invalid ${flagName}: ${input}`);
    return input * 1000;
  }
  const raw = input.trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let matchedLength = 0;
  for (const m of raw.matchAll(re)) {
    const value = Number(m[1]);
    const unit = m[2];
    matchedLength += m[0].length;
    if (unit === "ms") total += value;
    else if (unit === "s") total += value * 1000;
    else if (unit === "m") total += value * 60_000;
    else if (unit === "h") total += value * 3_600_000;
    else if (unit === "d") total += value * 86_400_000;
  }
  if (matchedLength !== raw.length || matchedLength === 0) {
    throw usageError(`invalid ${flagName}: "${input}"`, {
      help: [`use a number of seconds or a duration like 30s, 5m, 1h30m`],
    });
  }
  return total;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h${remMinutes}m` : `${hours}h`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
