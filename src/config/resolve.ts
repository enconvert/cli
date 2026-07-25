// Setting resolution: flag > env > project > user > system > default,
// with provenance recorded for `enconvert config debug`.
//
// Credential read chain (separate from settings):
//   --api-key <value|@file|-> > ENCONVERT_API_KEY > credential_helper > credentials.toml
//   > legacy ~/.enconvert/config.json (read-migrated)
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { CliError, EXIT, usageError } from "../api/errors.js";
import { resolveColorEnabled, setColorEnabled, type ColorMode } from "../output/color.js";
import { configureUi, verbose, warn } from "../output/streams.js";
import { parseDurationMs } from "../util/duration.js";
import { isInteractive } from "../util/tty.js";
import { loadConfigStack, stackLayers, type ConfigStack, type ProfileConfig } from "./config.js";
import {
  getLegacyMcpKey,
  getStoredKey,
  isValidKeyFormat,
  redactKey,
  runCredentialHelper,
  writeStoredKey,
} from "./credentials.js";

export const DEFAULT_API_URL = "https://api.enconvert.com";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRIES = 2;

export interface GlobalOpts {
  profile?: string;
  apiKey?: string;
  apiUrl?: string;
  config?: string;
  timeout?: string;
  retries?: number;
  concurrency?: number;
  color?: ColorMode;
  json?: boolean;
  jsonl?: boolean;
  jq?: string;
  template?: string;
  quiet?: boolean;
  verbose?: number;
  debug?: boolean;
  yes?: boolean;
  force?: boolean;
  skipExisting?: boolean;
  dryRun?: boolean;
  noInput?: boolean;
  noProgress?: boolean;
}

export interface Provenance {
  value: unknown;
  source: string;
}

export interface Context {
  opts: GlobalOpts;
  profileName: string;
  profileSource: string;
  apiUrl: string;
  timeoutMs: number;
  retries: number;
  concurrency: number;
  colorEnabled: boolean;
  provenance: Record<string, Provenance>;
  /** Resolved lazily; throws exit 4 when no credential can be found. */
  apiKey(): string;
  /** Like apiKey() but returns undefined instead of throwing. */
  tryApiKey(): string | undefined;
  /** Where the key came from; set after the first apiKey()/tryApiKey() call. */
  apiKeySource: string | undefined;
  stack: ConfigStack;
}

function profileSetting<K extends keyof ProfileConfig>(
  stack: ConfigStack,
  profileName: string,
  key: K,
): { value: NonNullable<ProfileConfig[K]>; source: string } | undefined {
  for (const layer of stackLayers(stack)) {
    const value = layer.loaded.config.profile?.[profileName]?.[key];
    if (value !== undefined) {
      return { value: value as NonNullable<ProfileConfig[K]>, source: layer.label };
    }
  }
  return undefined;
}

function readKeyFlagValue(raw: string): { key: string; source: string } {
  if (raw === "-") {
    const key = readFileSync(0, "utf8").trim();
    return { key, source: "flag --api-key (stdin)" };
  }
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      throw new CliError(`cannot read API key file: ${path}`, { exitCode: EXIT.INPUT_NOT_FOUND });
    }
    return { key: contents.trim(), source: `flag --api-key (@${path})` };
  }
  if (isInteractive()) {
    warn(
      "a raw API key on the command line ends up in shell history; prefer --api-key @file, --api-key -, or ENCONVERT_API_KEY",
    );
  }
  return { key: raw.trim(), source: "flag --api-key" };
}

export function buildContext(opts: GlobalOpts, env: NodeJS.ProcessEnv = process.env): Context {
  const provenance: Record<string, Provenance> = {};
  const stack = loadConfigStack(opts.config !== undefined ? { explicitPath: opts.config } : {});

  // Profile: -p/--profile > ENCONVERT_PROFILE > default_profile in config > "default".
  let profileName = "default";
  let profileSource = "default";
  if (opts.profile !== undefined) {
    profileName = opts.profile;
    profileSource = "flag --profile";
  } else if (env["ENCONVERT_PROFILE"] !== undefined && env["ENCONVERT_PROFILE"] !== "") {
    profileName = env["ENCONVERT_PROFILE"];
    profileSource = "env ENCONVERT_PROFILE";
  } else {
    for (const layer of stackLayers(stack)) {
      const dp = layer.loaded.config.default_profile;
      if (dp !== undefined) {
        profileName = dp;
        profileSource = layer.label;
        break;
      }
    }
  }
  // A profile explicitly requested must exist somewhere (except "default").
  if (profileSource.startsWith("flag") || profileSource.startsWith("env")) {
    if (profileName !== "default") {
      const defined = stackLayers(stack).some(
        (l) => l.loaded.config.profile?.[profileName] !== undefined,
      );
      if (!defined) {
        throw usageError(`profile "${profileName}" is not defined in any config file`, {
          help: [
            `add [profile.${profileName}] to ${stackLayers(stack)[0]?.loaded.path ?? "~/.config/enconvert/config.toml"}`,
            "or run `enconvert config list` to see what exists",
          ],
        });
      }
    }
  }
  provenance["profile"] = { value: profileName, source: profileSource };

  const resolveSetting = <T>(
    name: string,
    flagValue: T | undefined,
    envName: string | null,
    configKey: keyof ProfileConfig | null,
    defaultValue: T,
    parseEnv: (raw: string) => T,
  ): T => {
    if (flagValue !== undefined) {
      provenance[name] = { value: flagValue, source: `flag --${name.replace(/_/g, "-")}` };
      return flagValue;
    }
    if (envName !== null) {
      const raw = env[envName];
      if (raw !== undefined && raw !== "") {
        const value = parseEnv(raw);
        provenance[name] = { value, source: `env ${envName}` };
        return value;
      }
    }
    if (configKey !== null) {
      const fromConfig = profileSetting(stack, profileName, configKey);
      if (fromConfig !== undefined) {
        provenance[name] = { value: fromConfig.value, source: fromConfig.source };
        return fromConfig.value as unknown as T;
      }
    }
    provenance[name] = { value: defaultValue, source: "default" };
    return defaultValue;
  };

  const apiUrl = resolveSetting(
    "api_url",
    opts.apiUrl,
    "ENCONVERT_API_URL",
    "api_url",
    DEFAULT_API_URL,
    (raw) => raw,
  ).replace(/\/+$/, "");

  const timeoutRaw = resolveSetting<string | number>(
    "timeout",
    opts.timeout,
    "ENCONVERT_TIMEOUT",
    "timeout",
    DEFAULT_TIMEOUT_MS / 1000,
    (raw) => raw,
  );
  const timeoutMs = parseDurationMs(timeoutRaw, "--timeout");

  const retries = resolveSetting(
    "retries",
    opts.retries,
    null,
    "retries",
    DEFAULT_RETRIES,
    (raw) => Number(raw),
  );

  const defaultConcurrency = Math.min(8, Math.max(1, availableParallelism()));
  const concurrency = resolveSetting(
    "concurrency",
    opts.concurrency,
    null,
    "concurrency",
    defaultConcurrency,
    (raw) => Number(raw),
  );

  const configColor = profileSetting(stack, profileName, "color")?.value;
  // Commander maps --no-color to color:false and no flag to color:true when a
  // negatable option coexists with --color <when>; normalize to a ColorMode.
  const rawColor = opts.color as unknown;
  const colorFlag: ColorMode | undefined =
    rawColor === false ? "never" : typeof rawColor === "string" ? (rawColor as ColorMode) : undefined;
  const colorEnabled = resolveColorEnabled(colorFlag, configColor, env);
  setColorEnabled(colorEnabled);
  provenance["color"] = {
    value: colorEnabled ? "on" : "off",
    source:
      colorFlag !== undefined
        ? "flag --color"
        : configColor !== undefined
          ? (profileSetting(stack, profileName, "color")?.source ?? "config")
          : "auto",
  };

  const debug = opts.debug === true || env["ENCONVERT_DEBUG"] !== undefined;
  // Commander stores negated boolean flags under the POSITIVE name:
  // --no-input -> {input: false}, --no-progress -> {progress: false}.
  const raw = opts as Record<string, unknown>;
  const noInput =
    opts.noInput === true || raw["input"] === false || env["ENCONVERT_NO_INPUT"] !== undefined;
  const noProgress = opts.noProgress === true || raw["progress"] === false;

  configureUi({
    verbosity: opts.verbose ?? 0,
    quiet: opts.quiet === true,
    debug,
    jsonMode: opts.json === true || opts.jsonl === true,
  });

  let cachedKey: string | undefined;
  let cachedSource: string | undefined;
  let keyResolved = false;

  const resolveKey = (): { key: string; source: string } | undefined => {
    if (opts.apiKey !== undefined) {
      return readKeyFlagValue(opts.apiKey);
    }
    const envKey = env["ENCONVERT_API_KEY"];
    if (envKey !== undefined && envKey.trim() !== "") {
      return { key: envKey.trim(), source: "env ENCONVERT_API_KEY" };
    }
    const helper = profileSetting(stack, profileName, "credential_helper");
    if (helper !== undefined) {
      verbose(`running credential_helper from ${helper.source}`);
      return { key: runCredentialHelper(helper.value), source: `credential_helper (${helper.source})` };
    }
    const stored = getStoredKey(profileName);
    if (stored !== undefined) {
      return { key: stored.key, source: `credentials ${stored.path}` };
    }
    const legacy = getLegacyMcpKey();
    if (legacy !== undefined) {
      // Read-migrate: persist into credentials.toml so future runs use it.
      try {
        writeStoredKey(profileName, legacy.key);
        verbose(`migrated API key from ${legacy.path} (written by @enconvert/mcp)`);
      } catch {
        // Non-fatal: still usable this run.
      }
      return { key: legacy.key, source: `legacy ${legacy.path} (migrated)` };
    }
    return undefined;
  };

  const ctx: Context = {
    opts: { ...opts, debug, noInput, noProgress },
    profileName,
    profileSource,
    apiUrl,
    timeoutMs,
    retries,
    concurrency,
    colorEnabled,
    provenance,
    apiKeySource: undefined,
    stack,
    tryApiKey(): string | undefined {
      if (!keyResolved) {
        const result = resolveKey();
        cachedKey = result?.key;
        cachedSource = result?.source;
        keyResolved = true;
        ctx.apiKeySource = cachedSource;
        if (cachedKey !== undefined && !isValidKeyFormat(cachedKey)) {
          warn(
            `the API key from ${cachedSource ?? "?"} (${redactKey(cachedKey)}) does not look like an Enconvert key (expected sk_... or pk_..., length >= 45)`,
          );
        }
      }
      return cachedKey;
    },
    apiKey(): string {
      const key = ctx.tryApiKey();
      if (key === undefined) {
        throw new CliError("no API key configured", {
          exitCode: EXIT.AUTH,
          details: ["checked: --api-key, ENCONVERT_API_KEY, credential_helper, credentials.toml"],
          help: [
            "run `enconvert auth login`, or set ENCONVERT_API_KEY",
            "get a key at https://enconvert.com/dashboard/api-keys",
          ],
        });
      }
      return key;
    },
  };
  return ctx;
}
