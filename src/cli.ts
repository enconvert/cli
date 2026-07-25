#!/usr/bin/env node
// Entry point: EPIPE guard, SIGINT handling, top-level error boundary,
// exit-code mapping. Command registration lives in src/commands/index.ts.
import { CommanderError } from "commander";
import { CliError, EXIT } from "./api/errors.js";
import { renderError } from "./output/errors.js";
import { installEpipeGuard, uiState } from "./output/streams.js";
import { buildProgram, commanderErrorToExit, propagateGlobalOptions } from "./program.js";
import { registerCommands } from "./commands/index.js";
import { checkForUpdate, updateNagEnabled } from "./util/update-notifier.js";

installEpipeGuard();

process.on("SIGINT", () => {
  // Restore the cursor (spinners hide it), then exit 130 fast.
  if (Boolean(process.stderr.isTTY)) process.stderr.write("\x1b[?25h");
  process.exit(EXIT.SIGINT);
});

async function main(): Promise<number> {
  const program = buildProgram();
  registerCommands(program);
  propagateGlobalOptions(program);

  // Kick the update check off early so it never delays exit; it has its own
  // 24h cache and 1.5s budget. The nag prints AFTER the command's output.
  const updatePromise = updateNagEnabled() ? checkForUpdate() : Promise.resolve(null);

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      const { exitCode } = commanderErrorToExit(err);
      return exitCode;
    }
    if (err instanceof CliError) {
      renderError(err, { debug: uiState().debug });
      return err.exitCode;
    }
    renderError(err, { debug: uiState().debug });
    return EXIT.GENERIC;
  }

  try {
    const nag = await updatePromise;
    if (nag !== null) process.stderr.write(nag + "\n");
  } catch {
    // never let the nag fail a successful command
  }
  return typeof process.exitCode === "number" ? process.exitCode : EXIT.OK;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    renderError(err, { debug: uiState().debug });
    process.exitCode = EXIT.GENERIC;
  },
);
