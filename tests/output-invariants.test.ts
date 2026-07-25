// Output-contract invariants:
//   stdout = the artifact or the machine payload, nothing else;
//   stderr = everything human, including errors in --json mode;
//   --json is ANSI-free and stable regardless of colour forcing;
//   --jsonl parses line by line;
//   colour resolution: --color > FORCE_COLOR > NO_COLOR (non-empty) > CLICOLOR_FORCE;
//   EPIPE exits 0 silently.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLI_BIN, runCli, scratchDir, startMockGateway, TEST_KEY } from "./helpers/harness.js";

const ANSI = /\x1b\[/;

test("json_output_parses_and_carries_zero_ansi_even_with_force_color", async () => {
  // A real TTY cannot be allocated here; FORCE_COLOR=1 is the strongest
  // "pretend we are colourful" signal, and --json must ignore it entirely.
  const plain = await runCli(["formats", "--json"]);
  const forced = await runCli(["formats", "--json"], { env: { FORCE_COLOR: "1" } });
  assert.equal(plain.code, 0);
  assert.equal(forced.code, 0);
  const parsed = JSON.parse(forced.stdout) as unknown[];
  assert.ok(Array.isArray(parsed) && parsed.length > 0);
  assert.ok(!ANSI.test(forced.stdout), "--json stdout must contain no ANSI escapes");
  // Byte-identical whether or not colour is being forced.
  assert.equal(forced.stdout, plain.stdout);
});

test("jsonl_every_line_parses_independently", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v1/convert/json-to-xml", 200, {
      presigned_url: `${gw.url}/signed/out.xml`,
      object_key: "test/files/p1/out.xml",
      filename: "out-123.xml",
      file_size: 42,
      conversion_time_seconds: 0.05,
    });
    const home = scratchDir();
    writeFileSync(join(home, "a.json"), "{}\n");
    writeFileSync(join(home, "b.json"), "{}\n");
    const res = await runCli(["convert", "a.json", "b.json", "--to", "xml", "--jsonl"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(res.code, 0);
    const lines = res.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      assert.equal(record["object_key"], "test/files/p1/out.xml");
      assert.ok(typeof record["presigned_url"] === "string");
    }
    assert.ok(!ANSI.test(res.stdout));
  } finally {
    await gw.close();
  }
});

test("no_color_nonempty_strips_all_escapes_from_error_stderr", async () => {
  // CLICOLOR_FORCE=1 alone would force colour on; a non-empty NO_COLOR must
  // beat it (NO_COLOR sits above CLICOLOR_FORCE in the resolution order).
  const res = await runCli(["convert", "missing.docx", "--to", "pdf"], {
    env: { NO_COLOR: "1", CLICOLOR_FORCE: "1" },
  });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /error\[E003\]/);
  assert.ok(!ANSI.test(res.stderr), "NO_COLOR=1 must remove every ANSI escape");
});

test("no_color_empty_string_does_not_disable_colour", async () => {
  // Per the NO_COLOR spec: present AND non-empty disables. NO_COLOR="" is a
  // no-op, so CLICOLOR_FORCE=1 (FORCE_COLOR unset) keeps colour on.
  const res = await runCli(["convert", "missing.docx", "--to", "pdf"], {
    env: { NO_COLOR: "", CLICOLOR_FORCE: "1" },
  });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /error\[E003\]/);
  assert.ok(ANSI.test(res.stderr), 'NO_COLOR="" must retain colour when CLICOLOR_FORCE=1');
});

test("color_always_flag_beats_no_color_env", async () => {
  const res = await runCli(["convert", "missing.docx", "--to", "pdf", "--color", "always"], {
    env: { NO_COLOR: "1" },
  });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /error\[E003\]/);
  assert.ok(ANSI.test(res.stderr), "--color always must override NO_COLOR=1");
});

test("formats_stdout_is_ansi_free_when_piped_default_mode", async () => {
  // Auto colour mode with a piped stdout/stderr: the payload table on stdout
  // must be plain text.
  const res = await runCli(["formats"]);
  assert.equal(res.code, 0);
  assert.ok(!ANSI.test(res.stdout));
});

test("formats_stdout_is_ansi_free_when_piped_even_with_color_always", async () => {
  // renderTable is deliberately colour-free: tables are frequently the stdout
  // PAYLOAD (formats, ingest list) and stdout must never carry ANSI escapes.
  const res = await runCli(["formats", "--color", "always"]);
  assert.equal(res.code, 0);
  assert.ok(!ANSI.test(res.stdout), "payload table on stdout must stay ANSI-free");
});

test("errors_go_to_stderr_not_stdout_in_json_mode", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 401, { detail: "Invalid API Key" });
    const res = await runCli(["whoami", "--json"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(res.code, 4);
    assert.equal(res.stdout, "", "--json mode must never put error text on stdout");
    assert.match(res.stderr, /error\[E004\]/);
  } finally {
    await gw.close();
  }
});

test("epipe_on_stdout_exits_0_with_no_stack_trace", async () => {
  // Simulate `enconvert formats --json | head`: destroy the read end of the
  // stdout pipe after the first chunk. The CLI must exit 0 with a silent
  // stderr — never a stack trace.
  const home = scratchDir();
  const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, "formats", "--json"], {
      cwd: home,
      env: {
        PATH: process.env["PATH"] as string,
        HOME: home,
        USERPROFILE: home,
        ENCONVERT_CONFIG_DIR: join(home, "enconvert-config"),
        ENCONVERT_API_KEY: TEST_KEY,
        CI: "1",
        TERM: "xterm-256color",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.stdout.once("data", () => {
      child.stdout.destroy();
    });
    // Swallow the parent-side stream error raised by destroying the pipe.
    child.stdout.on("error", () => {});
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not exit within 15s after stdout was destroyed"));
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr.trim(), "", "EPIPE must be silent on stderr");
  assert.doesNotMatch(result.stderr, /at .*\(.*\)/, "no stack frames on EPIPE");
});
