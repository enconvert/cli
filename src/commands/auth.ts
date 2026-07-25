// auth login/logout/status/token/switch, plus hidden top-level login/logout
// aliases. Keys are validated against GET /v1/whoami because it is explicitly
// private-key-only: a clean 403 means "that is a pk_ key", which the generic
// /v1/auth/verify cannot distinguish.
import { readFileSync } from "node:fs";
import { password } from "@inquirer/prompts";
import type { Command } from "commander";
import { ApiError, CliError, EXIT, usageError } from "../api/errors.js";
import { whoami } from "../api/v1.js";
import {
  deleteStoredKey,
  getStoredKey,
  isValidKeyFormat,
  redactKey,
  writeStoredKey,
} from "../config/credentials.js";
import { credentialsFilePath, userConfigPath } from "../config/paths.js";
import { loadConfigFile, saveUserConfig, stackLayers } from "../config/config.js";
import type { Context } from "../config/resolve.js";
import { info, out, warn } from "../output/streams.js";
import { isInteractive } from "../util/tty.js";
import { contextFor } from "../program.js";
import { emitJson } from "./_shared.js";

/** A context whose credential is the candidate key, not the resolved one. */
function contextWithKey(ctx: Context, key: string): Context {
  return { ...ctx, apiKey: () => key, tryApiKey: () => key };
}

interface LoginOpts {
  withToken?: boolean;
}

async function readLoginKey(ctx: Context, opts: LoginOpts): Promise<string> {
  if (opts.withToken === true) {
    // stdin, never argv: argv leaks the key to `ps` and shell history.
    let raw: string;
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = "";
    }
    const key = raw.trim();
    if (key === "") {
      throw usageError("--with-token was given but stdin carried no key", {
        help: ["pipe the key in: enconvert auth login --with-token < key.txt"],
      });
    }
    return key;
  }
  if (ctx.opts.noInput === true) {
    throw usageError("--no-input is set and `auth login` needs a key", {
      help: [
        "pipe the key in: enconvert auth login --with-token < key.txt",
        "or set ENCONVERT_API_KEY",
      ],
    });
  }
  if (!isInteractive()) {
    throw usageError("cannot prompt for a key in a non-interactive session", {
      help: ["use --with-token and pipe the key on stdin"],
    });
  }
  const key = (await password({ message: "Paste your API key (sk_...)", mask: "*" })).trim();
  if (key === "") {
    throw usageError("no key entered");
  }
  return key;
}

async function loginAction(opts: LoginOpts, cmd: Command): Promise<void> {
  const ctx = contextFor(cmd);
  const key = await readLoginKey(ctx, opts);

  if (!isValidKeyFormat(key)) {
    warn(
      `${redactKey(key)} does not look like an Enconvert key (expected sk_... or pk_..., length >= 45); saving it anyway`,
    );
  }

  // Validate against the gateway before persisting. A network failure must not
  // block login (offline laptops, firewalled CI) — save with a warning instead.
  let identity: { project_id: string; plan_slug: string } | undefined;
  try {
    identity = await whoami(contextWithKey(ctx, key));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      throw new CliError("key not recognized by the gateway", {
        exitCode: EXIT.AUTH,
        details: [`the gateway rejected ${redactKey(key)} (HTTP 401)`],
        help: ["copy a fresh key from https://enconvert.com/dashboard/api-keys"],
      });
    }
    if (e instanceof ApiError && e.status === 403) {
      throw new CliError("that is a public pk_ key; the CLI needs your SECRET sk_ key", {
        exitCode: EXIT.AUTH,
        help: ["copy the sk_ key from https://enconvert.com/dashboard/api-keys"],
      });
    }
    const reason = e instanceof Error ? e.message : String(e);
    warn(`could not verify the key against the gateway (${reason}); saving it anyway`);
  }

  const path = writeStoredKey(ctx.profileName, key);

  const envKey = process.env["ENCONVERT_API_KEY"];
  if (envKey !== undefined && envKey.trim() !== "") {
    warn("ENCONVERT_API_KEY is set and takes precedence over the saved credential");
  }

  if (
    emitJson(ctx, {
      saved: true,
      path,
      profile: ctx.profileName,
      key: redactKey(key),
      verified: identity !== undefined,
      ...(identity ?? {}),
    })
  ) {
    return;
  }
  info(`saved ${redactKey(key)} for profile "${ctx.profileName}" to ${path}`);
  if (identity !== undefined) {
    info(`authenticated: project ${identity.project_id} on the ${identity.plan_slug} plan`);
  }
}

async function logoutAction(cmd: Command): Promise<void> {
  const ctx = contextFor(cmd);
  const removed = deleteStoredKey(ctx.profileName);
  const envKey = process.env["ENCONVERT_API_KEY"];
  const envStillSet = envKey !== undefined && envKey.trim() !== "";

  if (emitJson(ctx, { removed, profile: ctx.profileName, env_key_still_set: envStillSet })) {
    return;
  }
  if (removed) {
    info(`removed the stored key for profile "${ctx.profileName}" from ${credentialsFilePath()}`);
  } else {
    info(`no stored key for profile "${ctx.profileName}" — nothing removed`);
  }
  if (envStillSet) {
    warn("ENCONVERT_API_KEY is still set and wins over the credentials file; unset it to be fully logged out");
  }
}

async function statusAction(cmd: Command): Promise<void> {
  const ctx = contextFor(cmd);
  const key = ctx.tryApiKey();

  if (key === undefined) {
    if (emitJson(ctx, { authenticated: false, source: null, key: null })) {
      process.exitCode = EXIT.AUTH;
      return;
    }
    throw new CliError("no API key configured", {
      exitCode: EXIT.AUTH,
      details: ["checked: --api-key, ENCONVERT_API_KEY, credential_helper, credentials.toml"],
      help: ["run `enconvert auth login`, or set ENCONVERT_API_KEY"],
    });
  }

  const source = ctx.apiKeySource ?? "unknown";
  let identity: { project_id: string; plan_slug: string } | undefined;
  let liveCheckError: CliError | undefined;
  let unreachableReason: string | undefined;
  try {
    identity = await whoami(ctx);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      liveCheckError = new CliError("the API key was rejected by the gateway (HTTP 401)", {
        exitCode: EXIT.AUTH,
        details: [`key ${redactKey(key)} from ${source}`],
        help: ["run `enconvert auth login` with a fresh key"],
      });
    } else if (e instanceof ApiError && e.status === 403) {
      liveCheckError = new CliError("that is a public pk_ key; the CLI needs your SECRET sk_ key", {
        exitCode: EXIT.AUTH,
        details: [`key ${redactKey(key)} from ${source}`],
        help: ["copy the sk_ key from https://enconvert.com/dashboard/api-keys"],
      });
    } else {
      unreachableReason = e instanceof Error ? e.message : String(e);
    }
  }

  const payload: Record<string, unknown> = {
    authenticated: identity !== undefined,
    source,
    key: redactKey(key),
    ...(identity !== undefined
      ? { project_id: identity.project_id, plan_slug: identity.plan_slug }
      : {}),
    ...(liveCheckError !== undefined ? { error: liveCheckError.message } : {}),
    ...(unreachableReason !== undefined ? { error: unreachableReason } : {}),
  };
  if (emitJson(ctx, payload)) {
    if (liveCheckError !== undefined) process.exitCode = EXIT.AUTH;
    return;
  }

  out(`credential source: ${source}`);
  out(`api key: ${redactKey(key)}`);
  if (liveCheckError !== undefined) throw liveCheckError;
  if (identity !== undefined) {
    out(`authenticated: project ${identity.project_id} on the ${identity.plan_slug} plan`);
  } else {
    warn(`could not verify against the gateway: ${unreachableReason ?? "unknown error"}`);
  }
}

function tokenAction(cmd: Command): void {
  const ctx = contextFor(cmd);
  // Machine surface, like `gh auth token`: the raw key and nothing else.
  out(ctx.apiKey());
}

function switchAction(profileName: string, cmd: Command): void {
  const ctx = contextFor(cmd);

  const definedInConfig = new Set<string>(["default"]);
  for (const layer of stackLayers(ctx.stack)) {
    for (const name of Object.keys(layer.loaded.config.profile ?? {})) {
      definedInConfig.add(name);
    }
  }
  const hasCredential = getStoredKey(profileName) !== undefined;
  if (!definedInConfig.has(profileName) && !hasCredential) {
    throw new CliError(`profile "${profileName}" is not defined anywhere`, {
      details: [`known profiles: ${[...definedInConfig].sort().join(", ")}`],
      help: [
        `add [profile.${profileName}] to ${userConfigPath()}`,
        `or store a key for it: enconvert -p ${profileName} auth login`,
      ],
    });
  }

  const userConfig = loadConfigFile(userConfigPath())?.config ?? {};
  userConfig.default_profile = profileName;
  const path = saveUserConfig(userConfig);

  if (emitJson(ctx, { default_profile: profileName, path })) return;
  info(`default profile is now "${profileName}" (${path})`);
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description("authenticate the CLI with your Enconvert account");

  auth
    .command("login")
    .description("save an API key for the active profile (validated via GET /v1/whoami)")
    .option("--with-token", "read the API key from stdin (CI-safe; never argv)")
    .addHelpText(
      "after",
      `
Examples:
  enconvert auth login                          # interactive, hidden paste
  enconvert auth login --with-token < key.txt   # CI-safe: stdin, never argv
  enconvert -p staging auth login               # save under [profile.staging]
`,
    )
    .action(loginAction);

  auth
    .command("logout")
    .description("delete the stored API key for the active profile")
    .addHelpText(
      "after",
      `
Examples:
  enconvert auth logout
  enconvert -p staging auth logout
`,
    )
    .action(async (_opts: Record<string, never>, cmd: Command) => logoutAction(cmd));

  auth
    .command("status")
    .description("show which credential is in use and verify it against the gateway")
    .addHelpText(
      "after",
      `
Examples:
  enconvert auth status
  enconvert auth status --json    # {authenticated, source, key, project_id, plan_slug}
`,
    )
    .action(async (_opts: Record<string, never>, cmd: Command) => statusAction(cmd));

  auth
    .command("token")
    .description("print the resolved API key on stdout (for scripts; nothing else is printed)")
    .addHelpText(
      "after",
      `
Examples:
  curl -H "X-API-Key: $(enconvert auth token)" https://api.enconvert.com/v1/whoami
`,
    )
    .action((_opts: Record<string, never>, cmd: Command) => tokenAction(cmd));

  auth
    .command("switch <profile>")
    .description("set default_profile in the user config")
    .addHelpText(
      "after",
      `
Examples:
  enconvert auth switch staging
  enconvert auth switch default
`,
    )
    .action((profileName: string, _opts: Record<string, never>, cmd: Command) =>
      switchAction(profileName, cmd),
    );

  // Hidden top-level aliases for muscle memory: `enconvert login` / `logout`.
  program
    .command("login", { hidden: true })
    .description("alias for `enconvert auth login`")
    .option("--with-token", "read the API key from stdin (CI-safe; never argv)")
    .action(loginAction);

  program
    .command("logout", { hidden: true })
    .description("alias for `enconvert auth logout`")
    .action(async (_opts: Record<string, never>, cmd: Command) => logoutAction(cmd));
}
