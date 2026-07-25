// Help-surface smoke tests. `--help` output is a product surface: the root
// help must list every registered top-level command (src/commands/index.ts),
// every group must exit 0 on --help and mention its key flags/subcommands,
// and the static topic pages must carry their published content.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runCli } from "./helpers/harness.js";

// Visible top-level commands registered in src/commands/index.ts (the hidden
// ones — screenshot, login, logout — are deliberately absent from root help).
const TOP_LEVEL_COMMANDS = [
  "convert",
  "data",
  "compress",
  "pdf",
  "markdown",
  "url",
  "site",
  "perceive",
  "discover",
  "lookup",
  "distill",
  "ingest",
  "jobs",
  "files",
  "formats",
  "params",
  "whoami",
  "status",
  "usage",
  "version",
  "docs",
  "open",
  "auth",
  "config",
  "api",
  "completion",
  "upgrade",
  "mcp",
  "help",
];

test("root_help_lists_every_top_level_command", async () => {
  const res = await runCli(["--help"]);
  assert.equal(res.code, 0);
  for (const name of TOP_LEVEL_COMMANDS) {
    assert.match(res.stdout, new RegExp(`^\\s+${name}\\b`, "m"), `root help must list "${name}"`);
  }
});

// Each command group: --help exits 0 and mentions its key flags/subcommands.
const GROUP_HELP_CASES: Array<{ args: string[]; mustMention: string[] }> = [
  { args: ["convert"], mustMention: ["--to", "--from", "--endpoint", "--output", "--pdf-page-size"] },
  { args: ["url"], mustMention: ["pdf", "screenshot", "markdown"] },
  { args: ["url", "pdf"], mustMention: ["--viewport-width", "--wait-for-selector", "--async", "--zip", "--single-page"] },
  { args: ["site"], mustMention: ["pdf", "screenshot"] },
  { args: ["site", "pdf"], mustMention: ["--crawl-mode", "--include-pattern", "--exclude-pattern"] },
  { args: ["perceive"], mustMention: ["--output", "--extract", "--schema-file", "--wait-for", "--cache-mode"] },
  { args: ["discover"], mustMention: ["--mode", "--max-urls", "--max-depth", "--render-js"] },
  { args: ["lookup"], mustMention: ["--category", "--num-results", "--perceive-top", "--time-filter"] },
  { args: ["distill"], mustMention: ["--schema-file", "--prompt", "--discover-from", "--css-schema-file"] },
  { args: ["ingest"], mustMention: ["create", "files", "list", "get", "cancel", "retry-webhook", "webhook-secret"] },
  { args: ["jobs"], mustMention: ["get", "batch", "wait"] },
  { args: ["files"], mustMention: ["download"] },
  { args: ["auth"], mustMention: ["login", "logout", "status", "token", "switch"] },
  { args: ["config"], mustMention: ["get", "set", "unset", "list", "edit", "path", "debug"] },
  { args: ["api"], mustMention: ["--raw-field", "--field", "--input", "--paginate", "--list-endpoints", "--describe"] },
  { args: ["completion"], mustMention: ["bash", "zsh", "fish", "powershell"] },
  { args: ["mcp"], mustMention: ["install"] },
  { args: ["upgrade"], mustMention: ["brew", "scoop", "npm"] },
  { args: ["formats"], mustMention: ["--from", "--to"] },
];

for (const { args, mustMention } of GROUP_HELP_CASES) {
  test(`help_for_${args.join("_")}_exits_0_and_mentions_key_flags`, async () => {
    const res = await runCli([...args, "--help"]);
    assert.equal(res.code, 0, `\`${args.join(" ")} --help\` must exit 0`);
    for (const needle of mustMention) {
      assert.ok(
        res.stdout.includes(needle),
        `\`${args.join(" ")} --help\` must mention "${needle}"`,
      );
    }
  });
}

test("help_exit_codes_topic_contains_all_12_codes", async () => {
  const res = await runCli(["help", "exit-codes"]);
  assert.equal(res.code, 0);
  const rows: Array<[string, string]> = [
    ["0", "Success"],
    ["1", "Generic failure"],
    ["2", "Usage error"],
    ["3", "Input not found"],
    ["4", "Auth required"],
    ["5", "Rate limited"],
    ["6", "Plan gate"],
    ["7", "Unsupported conversion"],
    ["8", "Input rejected"],
    ["9", "Server-side failure"],
    ["10", "Network / timeout"],
    ["130", "SIGINT"],
  ];
  for (const [code, meaning] of rows) {
    assert.match(
      res.stdout,
      new RegExp(`^\\s*${code}\\s{2,}${meaning.replace(/[/\\]/g, "\\$&")}`, "m"),
      `exit-codes page must document code ${code} (${meaning})`,
    );
  }
});

test("help_environment_topic_mentions_key_variables", async () => {
  const res = await runCli(["help", "environment"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /ENCONVERT_API_KEY/);
  assert.match(res.stdout, /NO_COLOR/);
});

test("help_formatting_topic_documents_jq", async () => {
  const res = await runCli(["help", "formatting"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /--jq/);
  assert.match(res.stdout, /--template/);
  assert.match(res.stdout, /--jsonl/);
});

test("help_unknown_topic_exits_2", async () => {
  const res = await runCli(["help", "no-such-topic"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error\[E002\]/);
});

test("version_flag_prints_the_semver", async () => {
  const res = await runCli(["--version"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+(-[\w.]+)?$/);
});
