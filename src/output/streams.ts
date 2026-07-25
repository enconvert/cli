// stdout/stderr discipline:
//   stdout = the artifact or the machine payload. Nothing else, ever.
//   stderr = everything else (progress, warnings, errors, --verbose, update nag),
//            including in --json mode.
import { c } from "./color.js";

export interface UiState {
  verbosity: number;
  quiet: boolean;
  debug: boolean;
  jsonMode: boolean;
}

const state: UiState = { verbosity: 0, quiet: false, debug: false, jsonMode: false };

export function configureUi(next: Partial<UiState>): void {
  Object.assign(state, next);
}

export function uiState(): Readonly<UiState> {
  return state;
}

/** Machine payload / artifact path line on stdout. */
export function out(line: string): void {
  process.stdout.write(line + "\n");
}

/** Raw bytes on stdout (only for `-o -`). Never set an encoding. */
export function outBytes(buf: Uint8Array): boolean {
  return process.stdout.write(buf);
}

/** Human-facing informational line on stderr; suppressed by --quiet. */
export function info(line: string): void {
  if (state.quiet) return;
  process.stderr.write(line + "\n");
}

/** Warning on stderr; suppressed by --quiet. */
export function warn(line: string): void {
  if (state.quiet) return;
  process.stderr.write(c().yellow("warning: ") + line + "\n");
}

/** Error text on stderr; NEVER suppressed. */
export function errLine(line: string): void {
  process.stderr.write(line + "\n");
}

/** -v diagnostics on stderr; repeatable (-vv => level 2). */
export function verbose(line: string, level = 1): void {
  if (state.quiet || state.verbosity < level) return;
  process.stderr.write(c().dim(line) + "\n");
}

/** --debug tracing on stderr. */
export function debug(line: string): void {
  if (!state.debug) return;
  process.stderr.write(c().dim(`[debug] ${line}`) + "\n");
}

/**
 * Install the EPIPE guard BEFORE the first byte is written.
 * `enconvert ... | head` must exit 0 silently, never print a stack trace.
 */
export function installEpipeGuard(): void {
  const guard = (e: NodeJS.ErrnoException): void => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  };
  process.stdout.on("error", guard);
  process.stderr.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
}
