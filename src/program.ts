// Root Command: global options, exit-code remapping, context construction.
import { Command, CommanderError, Option } from "commander";
import { EXIT, usageError, type CliError } from "./api/errors.js";
import { buildContext, type Context, type GlobalOpts } from "./config/resolve.js";
import { VERSION } from "./version.js";

export type { Context } from "./config/resolve.js";

let cachedContext: Context | undefined;

/**
 * Resolve the Context from the command's merged option view (cached per run).
 * optsWithGlobals() merges leaf-to-root, so global flags work BOTH before and
 * after the subcommand name (propagateGlobalOptions adds hidden clones).
 */
export function contextFor(command: Command): Context {
  if (cachedContext === undefined) {
    cachedContext = buildContext(command.optsWithGlobals() as GlobalOpts);
  }
  return cachedContext;
}

/**
 * Users put flags wherever they like (`enconvert convert a.md --to pdf --json`),
 * but commander only parses root-level options BEFORE the subcommand. Clone
 * every root option onto every subcommand as a hidden option (no default, so
 * optsWithGlobals falls back to the root's default when unset). Short aliases
 * are dropped when the subcommand already claims them (-F on `api`, -q, ...).
 */
export function propagateGlobalOptions(root: Command): void {
  const skip = new Set(["--version", "--help"]);
  const globals = root.options.filter((o) => o.long !== undefined && !skip.has(o.long));
  const visit = (cmd: Command): void => {
    for (const sub of cmd.commands as Command[]) {
      for (const opt of globals) {
        if (sub.options.some((o) => o.long === opt.long)) continue;
        const shortTaken = opt.short !== undefined && sub.options.some((o) => o.short === opt.short);
        const flags = shortTaken ? opt.flags.replace(/^-\w,\s*/, "") : opt.flags;
        const clone = new Option(flags, opt.description);
        clone.hideHelp();
        if (opt.parseArg !== undefined) {
          clone.argParser(opt.parseArg as (value: string, previous: unknown) => unknown);
        }
        if (opt.argChoices !== undefined) clone.choices(opt.argChoices);
        sub.addOption(clone);
      }
      visit(sub);
    }
  };
  visit(root);
}

/** Test hook. */
export function resetContext(): void {
  cachedContext = undefined;
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function increaseVerbosity(_value: string, previous: number | undefined): number {
  return (previous ?? 0) + 1;
}

export function buildProgram(): Command {
  const program = new Command("enconvert");
  program
    .description("Convert files, render URLs, and extract web data from your terminal.\nDocs: https://enconvert.com/docs/cli")
    .version(VERSION, "-V, --version", "print the CLI version")
    .helpOption("-h, --help", "show help")
    .showSuggestionAfterError(true)
    .enablePositionalOptions()
    .configureHelp({ sortSubcommands: false })
    // Global flags — available on every subcommand via optsWithGlobals().
    .option("-v, --verbose", "diagnostics on stderr; repeatable (-vv)", increaseVerbosity, 0)
    .option("--debug", "stack traces and HTTP tracing (env ENCONVERT_DEBUG)")
    .option("-q, --quiet", "suppress non-essential stderr; errors still shown")
    .option("--json", "one JSON document on stdout (the gateway's raw response)")
    .option("--jsonl", "NDJSON stream on stdout")
    .option("--jq <expr>", "filter JSON output (bundled jq subset; no jq binary needed)")
    .option("--template <tmpl>", "format JSON output with a Go-style template")
    .addOption(new Option("--color <when>", "colourize output").choices(["auto", "always", "never"]))
    .addOption(new Option("--no-color", "disable colour (same as --color never)"))
    .option("--no-progress", "disable progress output")
    .option("-y, --yes", "assume yes for confirmation prompts")
    .option("-F, --force", "overwrite existing files / skip safety checks")
    .option("--skip-existing", "skip conversions whose output file already exists")
    .option("-n, --dry-run", "describe what would happen without executing or spending quota")
    .option("--no-input", "never prompt; fail (exit 2) if a required value is missing (env ENCONVERT_NO_INPUT)")
    .option("--config <path>", "use this config file only (env ENCONVERT_CONFIG)")
    .option("-p, --profile <name>", "config profile (env ENCONVERT_PROFILE)")
    .option("--api-key <key>", "API key; @file reads a file, - reads stdin (env ENCONVERT_API_KEY)")
    .option("--api-url <url>", "API base URL (env ENCONVERT_API_URL)")
    .option("--timeout <dur>", "per-HTTP-request timeout, e.g. 120s (NOT --wait-timeout)")
    .option("--retries <n>", "retries for idempotent requests", (v) => Number.parseInt(v, 10))
    .option("-j, --concurrency <n>", "parallel operations for multi-input commands", (v) => Number.parseInt(v, 10));

  // Commander exits 1 on usage errors; the published contract says 2.
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => process.stderr.write(str),
  });
  return program;
}

/** Map CommanderError codes onto the published exit-code table. */
export function commanderErrorToExit(err: CommanderError): { exitCode: number; silent: boolean } {
  switch (err.code) {
    case "commander.help":
    case "commander.helpDisplayed":
    case "commander.version":
      return { exitCode: EXIT.OK, silent: true };
    case "commander.unknownOption":
    case "commander.unknownCommand":
    case "commander.missingArgument":
    case "commander.missingMandatoryOptionValue":
    case "commander.optionMissingArgument":
    case "commander.excessArguments":
    case "commander.invalidArgument":
    case "commander.conflictingOption":
      return { exitCode: EXIT.USAGE, silent: true }; // commander already printed the message
    default:
      return { exitCode: EXIT.GENERIC, silent: false };
  }
}

/** Shared repeatable-flag collector for command modules. */
export { collectRepeatable };

/** Standard wait-related options for job-producing commands. */
export function addWaitOptions(cmd: Command, defaultWait = true): Command {
  cmd
    .option("--wait", "wait for the job to finish", defaultWait)
    .option("--no-wait", "print the job id and exit 0")
    .option("--poll-interval <s>", "seconds between polls", (v) => Number.parseInt(v, 10), 3)
    .option("--wait-timeout <dur>", "how long to block on a queued job (default 15m)", "15m")
    .option("--exit-status", "exit 9 when the job itself failed")
    .option("--url-only", "print the presigned URL, skip the download");
  return cmd;
}

export function ensureNoInputAllowed(ctx: Context, whatIsMissing: string): never {
  throw usageError(`--no-input is set and ${whatIsMissing}`, {
    help: ["provide the value via flags or environment variables"],
  });
}
