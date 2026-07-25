// Progress rendering. Rules:
//   - first output within 100 ms
//   - suppressed when: !stderr.isTTY, CI, --quiet, --json, --jsonl, --no-progress,
//     TERM=dumb, or the operation is expected to finish < 500 ms
//   - degrade, don't disappear: non-TTY emits plain `converting 19/40 report.pdf`
//     lines instead of a spinner
//   - on SIGINT/exit: restore the cursor
import yoctoSpinner, { type Spinner } from "yocto-spinner";
import { uiState } from "./streams.js";

export interface ProgressOptions {
  noProgress?: boolean;
  jsonMode?: boolean;
}

export function progressAllowed(opts: ProgressOptions = {}): boolean {
  const s = uiState();
  if (opts.noProgress || opts.jsonMode || s.jsonMode || s.quiet) return false;
  if (process.env["CI"]) return false;
  if (process.env["TERM"] === "dumb") return false;
  return true;
}

export interface ProgressHandle {
  update(text: string): void;
  /** Stop and clear (TTY) or stop emitting (plain). */
  stop(finalLine?: string): void;
  fail(finalLine?: string): void;
}

const active = new Set<Spinner>();
let cursorHookInstalled = false;

function installCursorHook(): void {
  if (cursorHookInstalled) return;
  cursorHookInstalled = true;
  const restore = (): void => {
    if (active.size > 0 && Boolean(process.stderr.isTTY)) {
      process.stderr.write("\x1b[?25h");
    }
  };
  process.on("exit", restore);
}

/**
 * Start a progress indicator on stderr. TTY: spinner. Non-TTY (when allowed):
 * plain line per update. Suppressed entirely: no-op handle.
 */
export function startProgress(label: string, opts: ProgressOptions = {}): ProgressHandle {
  if (!progressAllowed(opts)) {
    return { update: () => {}, stop: () => {}, fail: () => {} };
  }
  if (Boolean(process.stderr.isTTY)) {
    installCursorHook();
    const spinner = yoctoSpinner({ text: label, stream: process.stderr }).start();
    active.add(spinner);
    return {
      update: (text) => {
        spinner.text = text;
      },
      stop: (finalLine) => {
        active.delete(spinner);
        if (finalLine !== undefined) spinner.success(finalLine);
        else spinner.stop();
      },
      fail: (finalLine) => {
        active.delete(spinner);
        if (finalLine !== undefined) spinner.error(finalLine);
        else spinner.stop();
      },
    };
  }
  // Plain degradation: emit each update as its own stderr line.
  let last = "";
  const emit = (text: string): void => {
    if (text !== last) {
      process.stderr.write(text + "\n");
      last = text;
    }
  };
  emit(label);
  return {
    update: emit,
    stop: (finalLine) => {
      if (finalLine !== undefined) emit(finalLine);
    },
    fail: (finalLine) => {
      if (finalLine !== undefined) emit(finalLine);
    },
  };
}
