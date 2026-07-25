// `help [topic]`: command help plus the static reference pages exit-codes,
// environment, and formatting. The built-in help command is disabled first so
// this one owns the `help` name. Help text goes to stdout via out() — for a
// help command, the help IS the payload.
import type { Command } from "commander";
import { usageError } from "../api/errors.js";
import { out } from "../output/streams.js";
import { renderTable } from "../output/table.js";

// The published, append-only exit-code contract (IMPLEMENTATION-PLAN.md).
const EXIT_CODE_ROWS: string[][] = [
  ["0", "Success", "— (also: EPIPE — exit 0 silently, never a stack trace)"],
  ["1", "Generic failure", "Unclassified"],
  [
    "2",
    "Usage error",
    "Bad flag, missing arg, unknown subcommand, --no-input with a missing value, -o - with multiple inputs",
  ],
  ["3", "Input not found", "ENOENT, EACCES, empty glob"],
  ["4", "Auth required/invalid", "401"],
  ["5", "Rate limited", "429 — message carries Retry-After"],
  ["6", "Plan gate / quota", "402, and 403 feature gates"],
  ["7", "Unsupported conversion", "client-side matrix miss, or 415"],
  ["8", "Input rejected", "413, MIME/magic-byte mismatch, 400 on a file field"],
  ["9", "Server-side failure", "5xx from a converter, or job status: failed under --exit-status"],
  ["10", "Network / timeout", "DNS, connect, TLS, request timeout, 504"],
  ["130", "SIGINT", "Ctrl-C"],
];

function exitCodesPage(): string {
  return [
    "Exit codes",
    "",
    "This table is a published contract: codes are append-only and never renumbered.",
    "",
    renderTable(EXIT_CODE_ROWS, { header: ["CODE", "MEANING", "TRIGGER"], rightAlign: [0] }),
    "",
    "Use --exit-status on job-producing commands to get exit 9 when the JOB failed",
    "(the submission itself succeeding would otherwise exit 0).",
  ].join("\n");
}

function environmentPage(): string {
  const enconvertVars: string[][] = [
    ["ENCONVERT_API_KEY", "API key (sk_...); beats credential_helper and credentials.toml"],
    ["ENCONVERT_API_URL", "gateway base URL (default https://api.enconvert.com)"],
    ["ENCONVERT_PROFILE", "config profile to use (same as -p/--profile)"],
    ["ENCONVERT_CONFIG", "path to a single config file that replaces the normal stack"],
    ["ENCONVERT_CONFIG_DIR", "directory holding config.toml and credentials.toml"],
    ["ENCONVERT_TIMEOUT", "per-HTTP-request timeout (e.g. 120s; NOT --wait-timeout)"],
    ["ENCONVERT_DEBUG", "enable --debug tracing (stack traces + HTTP tracing)"],
    ["ENCONVERT_NO_INPUT", "never prompt; fail (exit 2) if a required value is missing"],
    ["ENCONVERT_NO_UPDATE_NOTIFIER", "disable the once-per-day update check"],
    ["ENCONVERT_INSTALL", "install.sh target directory (default ~/.enconvert)"],
    ["ENCONVERT_VERSION", "version for install.sh to install"],
  ];
  const standardVars: string[][] = [
    ["NO_COLOR", "disable colour when present AND non-empty (NO_COLOR=\"\" keeps colour)"],
    ["FORCE_COLOR", "force colour on; =0 forces it off (beats NO_COLOR)"],
    ["CLICOLOR", "=0 disables colour (BSD convention)"],
    ["CLICOLOR_FORCE", "non-zero forces colour on (BSD convention)"],
    ["TERM", "TERM=dumb disables colour and progress rendering"],
    ["CI", "disables prompts, progress animation, and the update nag"],
    ["PAGER", "reserved for future paged output"],
    ["TMPDIR", "where partial downloads (.tmp before atomic rename) are written"],
    ["DO_NOT_TRACK", "honoured by convention; the CLI sends no telemetry either way"],
    ["HTTP_PROXY / HTTPS_PROXY / NO_PROXY", "standard proxy variables for outbound requests"],
  ];
  return [
    "Environment variables",
    "",
    "Precedence for every setting: flag > env > project config > user config > system config > default.",
    "Run `enconvert config debug` to see which source won for each value.",
    "",
    renderTable(enconvertVars, { header: ["VARIABLE", "MEANING"] }),
    "",
    "Respected standard variables:",
    "",
    renderTable(standardVars, { header: ["VARIABLE", "MEANING"] }),
  ].join("\n");
}

function formattingPage(): string {
  return [
    "Output formatting",
    "",
    "stdout carries only the artifact path(s) or the machine payload; everything",
    "human (progress, warnings, errors) goes to stderr — including in --json mode.",
    "",
    "--json",
    "  Exactly one JSON document on stdout: the gateway's raw response, verbatim.",
    "  Byte-identical piped or on a TTY; zero ANSI escapes. Field names are API:",
    "  they are added to, never renamed.",
    "",
    "--jsonl",
    "  NDJSON: one compact JSON object per line, newline-terminated, flushed per",
    "  record, with a stable `type` discriminator on streamed records.",
    "",
    "--jq <expr>  (bundled jq subset; no jq binary needed)",
    "  .                    identity",
    "  .foo.bar             field access (optional with `?`: .foo?)",
    "  .foo[0]  .[2]        array index (negative allowed)",
    "  .foo[]   .[]         array/object-value iteration",
    "  |                    pipe",
    "  length  keys  first  last  flatten  type",
    "  select(.path == literal) / select(.path != literal)",
    "  join(\"sep\")",
    "",
    "  Results print one per line: strings raw, everything else as JSON",
    "  (the `gh --jq` convention).",
    "",
    "--template <tmpl>  (Go-template-flavoured subset)",
    "  {{.field.path}}            value substitution (strings raw, others JSON)",
    "  {{.}}                      the current value",
    "  {{range .path}}...{{end}}  iterate an array; inside, {{.x}} is the item",
    "  \\n and \\t escapes in the template string",
    "",
    "Examples:",
    "  enconvert whoami --json",
    "  enconvert api /v1/whoami --jq .plan_slug",
    "  enconvert ingest list --json --jq '.jobs[] | .job_id'",
    "  enconvert jobs get j123 --template '{{.status}}\\n'",
  ].join("\n");
}

const TOPIC_PAGES: Record<string, () => string> = {
  "exit-codes": exitCodesPage,
  environment: environmentPage,
  formatting: formattingPage,
};

/** Walk the command tree so `help auth login` shows the leaf command's help. */
function findCommand(program: Command, segments: string[]): Command | undefined {
  let current: Command = program;
  for (const segment of segments) {
    const next = current.commands.find(
      (sub) => sub.name() === segment || sub.aliases().includes(segment),
    );
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

export function registerHelpTopics(program: Command): void {
  // Replace the implicit `help [command]` with one that also knows the topics.
  program.helpCommand(false);

  program
    .command("help [topic...]")
    .description("show help for a command, or a topic: exit-codes, environment, formatting")
    .addHelpText(
      "after",
      `
Examples:
  enconvert help
  enconvert help convert
  enconvert help auth login
  enconvert help exit-codes
  enconvert help environment
  enconvert help formatting
`,
    )
    .action((topic: string[], _opts: Record<string, never>) => {
      const segments = topic ?? [];
      if (segments.length === 0) {
        program.outputHelp();
        return;
      }
      const first = segments[0] ?? "";
      const page = segments.length === 1 ? TOPIC_PAGES[first] : undefined;
      if (page !== undefined) {
        out(page());
        return;
      }
      const command = findCommand(program, segments);
      if (command === undefined) {
        throw usageError(`no command or help topic named "${segments.join(" ")}"`, {
          help: [
            `topics: ${Object.keys(TOPIC_PAGES).join(", ")}`,
            "run `enconvert help` for the command list",
          ],
        });
      }
      command.outputHelp();
    });
}
