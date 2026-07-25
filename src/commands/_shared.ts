// Helpers shared by command modules.
import { basename, isAbsolute, join, resolve } from "node:path";
import { confirm as inquirerConfirm } from "@inquirer/prompts";
import { usageError } from "../api/errors.js";
import type { Context } from "../config/resolve.js";
import { evaluateJq, formatJqResults } from "../output/jq.js";
import { printJson } from "../output/json.js";
import { renderTemplate } from "../output/template.js";
import { out } from "../output/streams.js";
import { parseDurationMs } from "../util/duration.js";
import { ensureDir, planOutputPath } from "../util/files.js";
import type { WaitOptions } from "../util/poll.js";
import { isInteractive } from "../util/tty.js";

/**
 * Emit a machine payload when --json/--jq/--template is active.
 * Returns true when something was printed (the caller should stop rendering).
 */
export function emitJson(ctx: Context, payload: unknown): boolean {
  if (ctx.opts.jq !== undefined) {
    const results = evaluateJq(ctx.opts.jq, payload);
    out(formatJqResults(results));
    return true;
  }
  if (ctx.opts.template !== undefined) {
    process.stdout.write(renderTemplate(ctx.opts.template, payload));
    return true;
  }
  if (ctx.opts.json === true) {
    printJson(payload);
    return true;
  }
  return false;
}

/** Translate per-command wait flags into util/poll WaitOptions. */
export function waitOptionsFrom(opts: { pollInterval?: number; waitTimeout?: string }): WaitOptions {
  const wait: WaitOptions = {};
  if (opts.pollInterval !== undefined) wait.pollIntervalSec = opts.pollInterval;
  if (opts.waitTimeout !== undefined) wait.waitTimeoutMs = parseDurationMs(opts.waitTimeout, "--wait-timeout");
  return wait;
}

/**
 * Confirm before a destructive or notably metered action.
 * --yes answers yes; --no-input (or a non-interactive session) fails with exit 2
 * instead of hanging on a prompt.
 */
export async function confirm(ctx: Context, question: string): Promise<boolean> {
  if (ctx.opts.yes === true) return true;
  if (ctx.opts.noInput === true || !isInteractive()) {
    throw usageError(`confirmation required: ${question}`, {
      help: ["pass -y/--yes to proceed without a prompt"],
    });
  }
  return inquirerConfirm({ message: question, default: false });
}

/**
 * Decide where a downloaded artifact lands.
 *  -o <path>  -> exactly there ("-" is handled by the caller BEFORE this)
 *  -O <dir>   -> dir/derivedName
 *  neither    -> derivedName in cwd (callers pass a name derived from the input)
 * Returns null when --skip-existing applies. Prints nothing.
 */
export function resolveArtifactPath(
  ctx: Context,
  opts: { output?: string; outputDir?: string },
  derivedName: string,
): string | null {
  let candidate: string;
  if (opts.output !== undefined && opts.output !== "-") {
    candidate = opts.output;
  } else if (opts.outputDir !== undefined) {
    ensureDir(opts.outputDir);
    candidate = join(opts.outputDir, basename(derivedName));
  } else {
    candidate = derivedName;
  }
  const planned = planOutputPath(candidate, {
    force: ctx.opts.force === true,
    skipExisting: ctx.opts.skipExisting === true,
  });
  if (planned === null) return null;
  return isAbsolute(planned) ? planned : resolve(planned);
}

/** Validate an http(s) URL argument early with a friendly usage error. */
export function requireHttpUrl(raw: string, what = "url"): string {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw usageError(`${what} must start with http:// or https://: ${raw}`);
  }
  return trimmed;
}

/** Parse "K: V" / "K=V" repeated --header flags into an object. */
export function parseHeaderFlags(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of values) {
    const m = /^([^:=]+)[:=]\s*(.*)$/.exec(raw);
    if (!m) throw usageError(`invalid --header "${raw}" (expected 'Name: value')`);
    headers[m[1]!.trim()] = m[2]!;
  }
  return headers;
}

/** Parse repeated --cookie 'name=value;domain=…;path=…;url=…' flags. */
export function parseCookieFlags(values: string[]): Array<Record<string, string>> {
  return values.map((raw) => {
    const parts = raw.split(";").map((p) => p.trim()).filter((p) => p !== "");
    const first = parts.shift();
    const eq = first?.indexOf("=") ?? -1;
    if (first === undefined || eq <= 0) {
      throw usageError(`invalid --cookie "${raw}" (expected 'name=value[;domain=…][;url=…][;path=…]')`);
    }
    const cookie: Record<string, string> = { name: first.slice(0, eq), value: first.slice(eq + 1) };
    for (const part of parts) {
      const pe = part.indexOf("=");
      if (pe <= 0) throw usageError(`invalid --cookie attribute "${part}" in "${raw}"`);
      cookie[part.slice(0, pe).toLowerCase()] = part.slice(pe + 1);
    }
    if (cookie["domain"] === undefined && cookie["url"] === undefined) {
      throw usageError(`--cookie "${raw}" needs a domain=… or url=… attribute (gateway requirement)`);
    }
    return cookie;
  });
}

/** Parse --basic-auth user:pass. */
export function parseBasicAuth(raw: string): { username: string; password: string } {
  const idx = raw.indexOf(":");
  if (idx <= 0) throw usageError(`invalid --basic-auth (expected user:pass)`);
  return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

/** Comma-separated list flag -> array (trimmed, empties dropped). */
export function csvList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
