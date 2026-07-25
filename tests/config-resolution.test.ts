// Config and credential resolution, exercised end-to-end with real files in a
// scratch HOME and verified through `config debug --json` provenance plus the
// x-api-key header the mock gateway actually receives.
//
// Setting ladder: flag > env > project .enconvertrc.toml > user config.toml > default.
// Credential chain: --api-key > ENCONVERT_API_KEY > credential_helper >
//                   credentials.toml > legacy ~/.enconvert/config.json (migrated).
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, scratchDir, startMockGateway, TEST_KEY } from "./helpers/harness.js";

interface DebugJson {
  profile: { name: string; source: string };
  settings: Record<string, { value: unknown; source: string }>;
  api_key: { present: boolean; key: string | null; source: string | null };
  config_files: string[];
}

function debugJson(stdout: string): DebugJson {
  return JSON.parse(stdout) as DebugJson;
}

/** The harness points ENCONVERT_CONFIG_DIR here; user config.toml lives inside. */
function configDirOf(home: string): string {
  return join(home, "enconvert-config");
}

function writeUserConfig(home: string, toml: string): void {
  mkdirSync(configDirOf(home), { recursive: true });
  writeFileSync(join(configDirOf(home), "config.toml"), toml);
}

function writeProjectConfig(home: string, toml: string): void {
  // runCli's default cwd is the scratch home, so the project file goes there.
  writeFileSync(join(home, ".enconvertrc.toml"), toml);
}

const USER_URL = "https://user-config.example";
const PROJECT_URL = "https://project-config.example";
const ENV_URL = "https://env-var.example";
const FLAG_URL = "https://flag.example";

test("api_url_defaults_with_default_provenance", async () => {
  const res = await runCli(["config", "debug", "--json"]);
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.settings["api_url"]!.value, "https://api.enconvert.com");
  assert.equal(dbg.settings["api_url"]!.source, "default");
});

test("api_url_user_config_beats_default", async () => {
  const home = scratchDir();
  writeUserConfig(home, `[profile.default]\napi_url = "${USER_URL}"\n`);
  const res = await runCli(["config", "debug", "--json"], { home });
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.settings["api_url"]!.value, USER_URL);
  assert.match(dbg.settings["api_url"]!.source, /^user /);
});

test("api_url_project_config_beats_user_config", async () => {
  const home = scratchDir();
  writeUserConfig(home, `[profile.default]\napi_url = "${USER_URL}"\n`);
  writeProjectConfig(home, `[profile.default]\napi_url = "${PROJECT_URL}"\n`);
  const res = await runCli(["config", "debug", "--json"], { home });
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.settings["api_url"]!.value, PROJECT_URL);
  assert.match(dbg.settings["api_url"]!.source, /^project /);
});

test("api_url_env_beats_project_config", async () => {
  const home = scratchDir();
  writeUserConfig(home, `[profile.default]\napi_url = "${USER_URL}"\n`);
  writeProjectConfig(home, `[profile.default]\napi_url = "${PROJECT_URL}"\n`);
  const res = await runCli(["config", "debug", "--json"], {
    home,
    env: { ENCONVERT_API_URL: ENV_URL },
  });
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.settings["api_url"]!.value, ENV_URL);
  assert.equal(dbg.settings["api_url"]!.source, "env ENCONVERT_API_URL");
});

test("api_url_flag_beats_env_and_everything_else", async () => {
  const home = scratchDir();
  writeUserConfig(home, `[profile.default]\napi_url = "${USER_URL}"\n`);
  writeProjectConfig(home, `[profile.default]\napi_url = "${PROJECT_URL}"\n`);
  const res = await runCli(["config", "debug", "--json", "--api-url", FLAG_URL], {
    home,
    env: { ENCONVERT_API_URL: ENV_URL },
  });
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.settings["api_url"]!.value, FLAG_URL);
  assert.equal(dbg.settings["api_url"]!.source, "flag --api-url");
});

const PROFILES_TOML = [
  'default_profile = "confprof"',
  "[profile.default]",
  "[profile.flagprof]",
  'api_url = "https://flagprof.example"',
  "[profile.envprof]",
  'api_url = "https://envprof.example"',
  "[profile.confprof]",
  'api_url = "https://confprof.example"',
  "",
].join("\n");

test("profile_flag_beats_env_profile", async () => {
  const home = scratchDir();
  writeUserConfig(home, PROFILES_TOML);
  const res = await runCli(["-p", "flagprof", "config", "debug", "--json"], {
    home,
    env: { ENCONVERT_PROFILE: "envprof" },
  });
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.profile.name, "flagprof");
  assert.equal(dbg.profile.source, "flag --profile");
  assert.equal(dbg.settings["api_url"]!.value, "https://flagprof.example");
});

test("profile_env_beats_default_profile_setting", async () => {
  const home = scratchDir();
  writeUserConfig(home, PROFILES_TOML);
  const res = await runCli(["config", "debug", "--json"], {
    home,
    env: { ENCONVERT_PROFILE: "envprof" },
  });
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.profile.name, "envprof");
  assert.equal(dbg.profile.source, "env ENCONVERT_PROFILE");
  assert.equal(dbg.settings["api_url"]!.value, "https://envprof.example");
});

test("profile_default_profile_setting_wins_when_no_flag_or_env", async () => {
  const home = scratchDir();
  writeUserConfig(home, PROFILES_TOML);
  const res = await runCli(["config", "debug", "--json"], { home });
  assert.equal(res.code, 0);
  const dbg = debugJson(res.stdout);
  assert.equal(dbg.profile.name, "confprof");
  assert.match(dbg.profile.source, /^user /);
  assert.equal(dbg.settings["api_url"]!.value, "https://confprof.example");
});

test("unknown_profile_flag_exits_2", async () => {
  const home = scratchDir();
  writeUserConfig(home, PROFILES_TOML);
  const res = await runCli(["-p", "nope", "config", "debug"], { home });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /error\[E002\]/);
  assert.match(res.stderr, /"nope" is not defined/);
});

const KEY_FILE = "sk_" + "b".repeat(43);
const KEY_ENV = "sk_" + "e".repeat(43);
const KEY_FLAG = "sk_" + "f".repeat(43);
const KEY_LEGACY = "sk_" + "l".repeat(43);
const KEY_HELPER = "sk_" + "h".repeat(43);

test("auth_login_with_token_writes_0600_credentials_and_whoami_uses_them", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_test", plan_slug: "pro" });
    const home = scratchDir();

    const login = await runCli(["auth", "login", "--with-token"], {
      home,
      stdin: KEY_FILE + "\n",
      env: { ENCONVERT_API_URL: gw.url, ENCONVERT_API_KEY: undefined },
    });
    assert.equal(login.code, 0);
    // Login validates the candidate key against GET /v1/whoami.
    assert.equal(gw.requests[0]!.headers["x-api-key"], KEY_FILE);

    const credPath = join(configDirOf(home), "credentials.toml");
    assert.ok(existsSync(credPath), "credentials.toml must exist after login");
    if (process.platform !== "win32") {
      // POSIX file modes do not exist on Windows (the writer guards its
      // chmod the same way) — assert 0600 only where the OS can express it.
      assert.equal(statSync(credPath).mode & 0o777, 0o600, "credentials.toml must be 0600");
    }
    assert.match(readFileSync(credPath, "utf8"), new RegExp(KEY_FILE));

    // With no env key, whoami must fall back to the stored credential.
    const who = await runCli(["whoami"], {
      home,
      env: { ENCONVERT_API_URL: gw.url, ENCONVERT_API_KEY: undefined },
    });
    assert.equal(who.code, 0);
    assert.equal(gw.requests.at(-1)!.headers["x-api-key"], KEY_FILE);
  } finally {
    await gw.close();
  }
});

test("env_api_key_beats_stored_credentials", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_test", plan_slug: "pro" });
    const home = scratchDir();
    // Seed a stored credential directly (0600, same shape auth login writes).
    mkdirSync(configDirOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(configDirOf(home), "credentials.toml"),
      `[profile.default]\napi_key = "${KEY_FILE}"\n`,
      { mode: 0o600 },
    );
    const res = await runCli(["whoami"], {
      home,
      env: { ENCONVERT_API_URL: gw.url, ENCONVERT_API_KEY: KEY_ENV },
    });
    assert.equal(res.code, 0);
    assert.equal(gw.requests.at(-1)!.headers["x-api-key"], KEY_ENV);
  } finally {
    await gw.close();
  }
});

test("api_key_flag_beats_env_api_key", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_test", plan_slug: "pro" });
    const res = await runCli(["whoami", "--api-key", KEY_FLAG], {
      env: { ENCONVERT_API_URL: gw.url, ENCONVERT_API_KEY: KEY_ENV },
    });
    assert.equal(res.code, 0);
    assert.equal(gw.requests.at(-1)!.headers["x-api-key"], KEY_FLAG);
  } finally {
    await gw.close();
  }
});

test("legacy_mcp_config_json_is_used_and_migrated_to_credentials_toml", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_test", plan_slug: "pro" });
    const home = scratchDir();
    // The @enconvert/mcp legacy store: $HOME/.enconvert/config.json.
    mkdirSync(join(home, ".enconvert"), { recursive: true });
    writeFileSync(join(home, ".enconvert", "config.json"), JSON.stringify({ api_key: KEY_LEGACY }));

    const res = await runCli(["whoami"], {
      home,
      env: { ENCONVERT_API_URL: gw.url, ENCONVERT_API_KEY: undefined },
    });
    assert.equal(res.code, 0);
    assert.equal(gw.requests.at(-1)!.headers["x-api-key"], KEY_LEGACY);

    // Read-migration: the key must now also live in credentials.toml.
    const credPath = join(configDirOf(home), "credentials.toml");
    assert.ok(existsSync(credPath), "migration must write credentials.toml");
    assert.match(readFileSync(credPath, "utf8"), new RegExp(KEY_LEGACY));
  } finally {
    await gw.close();
  }
});

test("credential_helper_command_resolves_the_key", async () => {
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_test", plan_slug: "pro" });
    const home = scratchDir();
    writeUserConfig(home, `[profile.default]\ncredential_helper = "printf ${KEY_HELPER}"\n`);
    const res = await runCli(["whoami"], {
      home,
      env: { ENCONVERT_API_URL: gw.url, ENCONVERT_API_KEY: undefined },
    });
    assert.equal(res.code, 0);
    assert.equal(gw.requests.at(-1)!.headers["x-api-key"], KEY_HELPER);
  } finally {
    await gw.close();
  }
});

test("harness_default_env_key_reaches_the_gateway", async () => {
  // Baseline sanity for the whole chain: the harness's TEST_KEY env credential
  // is what the gateway sees when nothing overrides it.
  const gw = await startMockGateway();
  try {
    gw.json("GET /v1/whoami", 200, { project_id: "proj_test", plan_slug: "free" });
    const res = await runCli(["whoami", "--json"], { env: { ENCONVERT_API_URL: gw.url } });
    assert.equal(res.code, 0);
    assert.equal(gw.requests[0]!.headers["x-api-key"], TEST_KEY);
    const body = JSON.parse(res.stdout) as Record<string, unknown>;
    assert.equal(body["project_id"], "proj_test");
  } finally {
    await gw.close();
  }
});
