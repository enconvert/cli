// Exit-code contract tests: one end-to-end provocation per documented code.
// The table in `enconvert help exit-codes` is append-only; each of these tests
// pins one row of it by actually provoking the condition through the built CLI.
//
// Every error the CLI renders itself carries an error[EXXX] id where XXX is the
// exit code zero-padded (src/api/errors.ts errorId). Commander-printed usage
// errors (unknown option) are the one exception: commander writes its own
// message and cli.ts exits silently with 2 (src/program.ts commanderErrorToExit).
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, scratchDir, startMockGateway, TEST_KEY } from "./helpers/harness.js";

test("exit_0_formats_succeeds_offline", async () => {
  const res = await runCli(["formats"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /json-to-xml/);
  assert.match(res.stdout, /anything-to-pdf/);
});

test("exit_2_unknown_option_is_usage_error", async () => {
  const res = await runCli(["formats", "--definitely-not-a-flag"]);
  assert.equal(res.code, 2);
  // Commander prints this one itself (no error[E002] renderer involved).
  assert.match(res.stderr, /unknown option/);
  assert.equal(res.stdout, "");
});

test("exit_2_mistyped_command_perceve_suggests_perceive", async () => {
  // "perceve" default-routes into `convert`, which must detect the mistyped
  // command (extensionless, path-less, nonexistent) and exit 2 — never 3.
  const res = await runCli(["perceve"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error\[E002\]/);
  assert.match(res.stderr, /unknown command "perceve"/);
  assert.match(res.stderr, /perceive/); // Levenshtein suggestion
});

test("exit_2_output_dash_with_two_inputs_on_convert", async () => {
  const home = scratchDir();
  writeFileSync(join(home, "a.json"), "{}\n");
  writeFileSync(join(home, "b.json"), "{}\n");
  const res = await runCli(["convert", "a.json", "b.json", "--to", "xml", "-o", "-"], { home });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error\[E002\]/);
  assert.match(res.stderr, /exactly one input/);
});

test("exit_2_no_input_where_a_value_is_required_auth_login", async () => {
  // --no-input + no stdin key: must fail fast at 2, never hang on a prompt.
  const res = await runCli(["auth", "login", "--no-input"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error\[E002\]/);
});

test("exit_3_nonexistent_input_file", async () => {
  const res = await runCli(["convert", "missing.docx", "--to", "pdf"]);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /error\[E003\]/);
  assert.match(res.stderr, /missing\.docx/);
});

test("exit_3_empty_glob", async () => {
  // Fresh scratch home as cwd: the glob cannot match anything.
  const res = await runCli(["convert", "*.docx", "--to", "pdf"]);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /error\[E003\]/);
  assert.match(res.stderr, /no files match/);
});

test("exit_4_no_api_key_configured_anywhere", async () => {
  // Remove the harness's default key; empty scratch home has no credentials.
  const res = await runCli(["whoami"], { env: { ENCONVERT_API_KEY: undefined } });
  assert.equal(res.code, 4);
  assert.match(res.stderr, /error\[E004\]/);
  assert.match(res.stderr, /no API key configured/);
});

test("exit_4_gateway_401_invalid_key", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 401, { detail: "Invalid API Key" });
    const res = await runCli(["whoami"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(res.code, 4);
    assert.match(res.stderr, /error\[E004\]/);
    assert.equal(gw.requests.length, 1);
    assert.equal(gw.requests[0]!.headers["x-api-key"], TEST_KEY);
  } finally {
    await gw.close();
  }
});

test("exit_5_rate_limited_429_with_retry_after_on_url_pdf", async () => {
  const gw = await startMockGateway();
  try {
    gw.json(
      "POST /v1/convert/url-to-pdf",
      429,
      { detail: "Rate limit exceeded. Please slow down and retry shortly." },
      { "retry-after": "7", "ratelimit-limit": "5", "ratelimit-remaining": "0" },
    );
    const res = await runCli(["url", "pdf", "https://example.com"], {
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(res.code, 5);
    assert.match(res.stderr, /error\[E005\]/);
    assert.match(res.stderr, /retry after 7s/);
    // A POST is not idempotent: exactly one request, no client-side retry.
    assert.equal(gw.requests.length, 1);
  } finally {
    await gw.close();
  }
});

test("exit_6_plan_gate_402_on_distill", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("POST /v2/distill", 402, {
      detail: "Monthly distill quota exhausted for your plan.",
    });
    const res = await runCli(["distill", "https://example.com", "--prompt", "product name"], {
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(res.code, 6);
    assert.match(res.stderr, /error\[E006\]/);
    assert.match(res.stderr, /enconvert\.com\/pricing/);
  } finally {
    await gw.close();
  }
});

test("exit_7_unsupported_conversion_pair_offline", async () => {
  const home = scratchDir();
  writeFileSync(join(home, "report.docx"), "not really a docx\n");
  // api-url points at a closed port: exiting 7 (not 10) proves the matrix
  // miss is decided client-side without any network request.
  const res = await runCli(["convert", "report.docx", "--to", "webp"], {
    home,
    env: { ENCONVERT_API_URL: "http://127.0.0.1:1" },
  });
  assert.equal(res.code, 7);
  assert.match(res.stderr, /error\[E007\]/);
  assert.match(res.stderr, /no conversion from \.docx to webp/);
});

test("exit_8_upload_rejected_413_detail_envelope", async () => {
  const gw = await startMockGateway();
  try {
    // Envelope shape 2 from the api contract: 413 from validate_file_size.
    gw.json("POST /v1/convert/json-to-xml", 413, {
      detail: {
        error: "File too large",
        file_size: 9999999,
        max_size: 5242880,
        tier: "free",
        key_type: "private",
      },
    });
    const home = scratchDir();
    writeFileSync(join(home, "big.json"), "{}\n");
    const res = await runCli(["convert", "big.json", "--to", "xml"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(res.code, 8);
    assert.match(res.stderr, /error\[E008\]/);
    assert.match(res.stderr, /File too large/);
    assert.match(res.stderr, /plan limit/);
  } finally {
    await gw.close();
  }
});

test("exit_9_server_failure_500_conversion_error_envelope_on_lookup", async () => {
  const gw = await startMockGateway();
  try {
    // Envelope shape 4 (ConversionError): {error, code, detail}.
    gw.json("POST /v2/lookup", 500, {
      error: "Lookup failed. Reference lookup_id '42' when contacting support.",
      code: "conversion_error",
      detail: "search adapter crashed",
    });
    const res = await runCli(["lookup", "best pdf tools"], {
      env: { ENCONVERT_API_URL: gw.url },
    });
    assert.equal(res.code, 9);
    assert.match(res.stderr, /error\[E009\]/);
    // parseApiError surfaces the string `detail` field as the headline.
    assert.match(res.stderr, /search adapter crashed/);
  } finally {
    await gw.close();
  }
});

test("exit_10_gateway_504_request_timeout", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 504, { error: "Request timeout" });
    const res = await runCli(["whoami"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(res.code, 10);
    assert.match(res.stderr, /error\[E010\]/);
  } finally {
    await gw.close();
  }
});

test("exit_10_connection_refused", async () => {
  const res = await runCli(["whoami", "--api-url", "http://127.0.0.1:1", "--retries", "0"]);
  assert.equal(res.code, 10);
  assert.match(res.stderr, /error\[E010\]/);
  assert.match(res.stderr, /could not reach 127\.0\.0\.1:1/);
});
