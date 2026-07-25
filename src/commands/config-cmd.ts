// config get/set/unset/list/edit/path/debug. set/unset mutate ONLY the user
// config file — project and system files are read-only from the CLI so a
// stray `config set` can never edit a repo-committed .enconvertrc.toml.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { CliError, usageError } from "../api/errors.js";
import {
  loadConfigFile,
  saveUserConfig,
  stackLayers,
  type ConfigFile,
  type ProfileConfig,
} from "../config/config.js";
import { redactKey } from "../config/credentials.js";
import { PROJECT_CONFIG_FILENAME, systemConfigPath, userConfigPath } from "../config/paths.js";
import type { Context } from "../config/resolve.js";
import { out, info, warn } from "../output/streams.js";
import { renderTable } from "../output/table.js";
import { parseDurationMs } from "../util/duration.js";
import { contextFor } from "../program.js";
import { emitJson } from "./_shared.js";

const PROFILE_KEYS = [
  "api_url",
  "color",
  "concurrency",
  "timeout",
  "retries",
  "credential_helper",
] as const;
type ProfileKey = (typeof PROFILE_KEYS)[number];
const ALL_KEYS = [...PROFILE_KEYS, "default_profile"] as const;
type SettableKey = (typeof ALL_KEYS)[number];

function assertSettableKey(key: string): SettableKey {
  if ((ALL_KEYS as readonly string[]).includes(key)) return key as SettableKey;
  throw usageError(`unknown config key "${key}"`, {
    help: [`valid keys: ${ALL_KEYS.join(", ")}`],
  });
}

/** Parse and validate a `config set` value; numbers become numbers. */
function parseSettingValue(key: SettableKey, raw: string): string | number {
  switch (key) {
    case "api_url": {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw usageError(`api_url must be a full URL, got "${raw}"`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw usageError(`api_url must use http:// or https://, got "${raw}"`);
      }
      return raw.replace(/\/+$/, "");
    }
    case "color":
      if (raw !== "auto" && raw !== "always" && raw !== "never") {
        throw usageError(`color must be auto, always, or never, got "${raw}"`);
      }
      return raw;
    case "concurrency": {
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1 || n > 64 || String(n) !== raw.trim()) {
        throw usageError(`concurrency must be an integer between 1 and 64, got "${raw}"`);
      }
      return n;
    }
    case "retries": {
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 0 || n > 10 || String(n) !== raw.trim()) {
        throw usageError(`retries must be an integer between 0 and 10, got "${raw}"`);
      }
      return n;
    }
    case "timeout":
      parseDurationMs(raw, "timeout"); // throws usage error when unparseable
      return raw;
    case "credential_helper":
    case "default_profile":
      if (raw.trim() === "") throw usageError(`${key} cannot be empty`);
      return raw;
  }
}

interface ResolvedSetting {
  value: unknown;
  source: string;
}

function profileSettingFromStack(ctx: Context, key: keyof ProfileConfig): ResolvedSetting | undefined {
  for (const layer of stackLayers(ctx.stack)) {
    const value = layer.loaded.config.profile?.[ctx.profileName]?.[key];
    if (value !== undefined) return { value, source: layer.label };
  }
  return undefined;
}

function defaultProfileFromStack(ctx: Context): ResolvedSetting {
  for (const layer of stackLayers(ctx.stack)) {
    const value = layer.loaded.config.default_profile;
    if (value !== undefined) return { value, source: layer.label };
  }
  return { value: "default", source: "default" };
}

/** Every setting the CLI resolves, with its provenance, keyed by name. */
function resolveAllSettings(ctx: Context): Record<string, ResolvedSetting> {
  const fromProvenance = (name: string): ResolvedSetting =>
    ctx.provenance[name] ?? { value: undefined, source: "default" };

  // The color flag/env resolution collapses to on/off in provenance; for
  // config surfaces the configured MODE is the useful value.
  const rawColorFlag = ctx.opts.color as unknown;
  const colorMode: ResolvedSetting =
    rawColorFlag === false
      ? { value: "never", source: "flag --no-color" }
      : typeof rawColorFlag === "string"
        ? { value: rawColorFlag, source: "flag --color" }
        : (profileSettingFromStack(ctx, "color") ?? { value: "auto", source: "default" });

  return {
    api_url: fromProvenance("api_url"),
    color: colorMode,
    concurrency: fromProvenance("concurrency"),
    timeout: fromProvenance("timeout"),
    retries: fromProvenance("retries"),
    credential_helper:
      profileSettingFromStack(ctx, "credential_helper") ?? { value: undefined, source: "default" },
    default_profile: defaultProfileFromStack(ctx),
  };
}

/** Every config file location the resolver consulted, loaded or not. */
function consultedFiles(ctx: Context): string[] {
  if (ctx.stack.explicit !== undefined) {
    return [`config ${ctx.stack.explicit.path} (via --config; replaces the stack)`];
  }
  const lines: string[] = [];
  lines.push(
    ctx.stack.project !== undefined
      ? `project ${ctx.stack.project.path}`
      : `project ${PROJECT_CONFIG_FILENAME} (none found walking up from cwd)`,
  );
  lines.push(
    ctx.stack.user !== undefined
      ? `user ${ctx.stack.user.path}`
      : `user ${userConfigPath()} (not found)`,
  );
  const sysPath = systemConfigPath();
  if (sysPath !== null) {
    lines.push(ctx.stack.system !== undefined ? `system ${ctx.stack.system.path}` : `system ${sysPath} (not found)`);
  }
  return lines;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  return String(value);
}

function setAction(rawKey: string, rawValue: string, cmd: Command): void {
  const ctx = contextFor(cmd);
  const key = assertSettableKey(rawKey);
  const value = parseSettingValue(key, rawValue);

  const cfg: ConfigFile = loadConfigFile(userConfigPath())?.config ?? {};
  if (key === "default_profile") {
    cfg.default_profile = value as string;
  } else {
    cfg.profile = cfg.profile ?? {};
    const profile = cfg.profile[ctx.profileName] ?? {};
    (profile as Record<string, unknown>)[key] = value;
    cfg.profile[ctx.profileName] = profile;
  }
  const path = saveUserConfig(cfg);

  if (emitJson(ctx, { key, value, profile: key === "default_profile" ? null : ctx.profileName, path })) return;
  if (key === "default_profile") {
    info(`set default_profile = ${String(value)} in ${path}`);
  } else {
    info(`set ${key} = ${String(value)} under [profile.${ctx.profileName}] in ${path}`);
  }
}

function unsetAction(rawKey: string, cmd: Command): void {
  const ctx = contextFor(cmd);
  const key = assertSettableKey(rawKey);

  const cfg: ConfigFile | undefined = loadConfigFile(userConfigPath())?.config;
  let removed = false;
  if (cfg !== undefined) {
    if (key === "default_profile") {
      removed = cfg.default_profile !== undefined;
      delete cfg.default_profile;
    } else {
      const profile = cfg.profile?.[ctx.profileName];
      if (profile !== undefined && (profile as Record<string, unknown>)[key] !== undefined) {
        removed = true;
        delete (profile as Record<string, unknown>)[key];
        if (Object.keys(profile).length === 0 && cfg.profile !== undefined) {
          delete cfg.profile[ctx.profileName];
          if (Object.keys(cfg.profile).length === 0) delete cfg.profile;
        }
      }
    }
    if (removed) saveUserConfig(cfg);
  }

  if (emitJson(ctx, { key, removed, profile: key === "default_profile" ? null : ctx.profileName })) return;
  if (removed) {
    info(`removed ${key} from ${userConfigPath()}`);
  } else {
    info(`${key} was not set in the user config — nothing removed`);
  }
}

function getAction(rawKey: string, cmd: Command): void {
  const ctx = contextFor(cmd);
  const key = assertSettableKey(rawKey);
  const resolved = resolveAllSettings(ctx)[key] ?? { value: undefined, source: "default" };

  if (emitJson(ctx, { key, value: resolved.value ?? null, source: resolved.source })) return;
  if (resolved.value !== undefined) out(String(resolved.value));
}

function listAction(cmd: Command): void {
  const ctx = contextFor(cmd);
  const settings = resolveAllSettings(ctx);

  if (
    emitJson(ctx, {
      profile: ctx.profileName,
      ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.value ?? null])),
    })
  ) {
    return;
  }
  const rows: string[][] = [["profile", ctx.profileName]];
  for (const [key, resolved] of Object.entries(settings)) {
    rows.push([key, formatValue(resolved.value)]);
  }
  out(renderTable(rows, { header: ["KEY", "VALUE"] }));
}

function editAction(cmd: Command): void {
  const ctx = contextFor(cmd);
  if (ctx.opts.noInput === true) {
    throw usageError("--no-input is set; cannot open an editor", {
      help: ["use `enconvert config set <key> <value>` instead"],
    });
  }
  const path = userConfigPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        "# enconvert configuration — see `enconvert help environment`",
        '# default_profile = "default"',
        "#",
        "# [profile.default]",
        '# api_url = "https://api.enconvert.com"',
        '# color = "auto"',
        "",
      ].join("\n"),
    );
  }
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
  const result = spawnSync(`${editor} "${path}"`, { shell: true, stdio: "inherit" });
  if (result.error !== undefined) {
    throw new CliError(`could not launch editor "${editor}"`, {
      details: [result.error.message],
      help: ["set $EDITOR to a working editor command"],
    });
  }
  if (result.status !== 0) {
    warn(`editor exited with status ${result.status ?? "unknown"}`);
  }
  // Re-validate so a broken edit fails loudly now, not on the next command.
  loadConfigFile(path);
  info(`edited ${path}`);
}

function pathAction(cmd: Command): void {
  const ctx = contextFor(cmd);
  if (emitJson(ctx, { path: userConfigPath() })) return;
  out(userConfigPath());
}

function debugAction(cmd: Command): void {
  const ctx = contextFor(cmd);
  const settings = resolveAllSettings(ctx);
  const key = ctx.tryApiKey();
  const keySource = ctx.apiKeySource;
  const files = consultedFiles(ctx);

  if (
    emitJson(ctx, {
      profile: { name: ctx.profileName, source: ctx.profileSource },
      settings: Object.fromEntries(
        Object.entries(settings).map(([k, v]) => [k, { value: v.value ?? null, source: v.source }]),
      ),
      api_key:
        key !== undefined
          ? { present: true, key: redactKey(key), source: keySource ?? "unknown" }
          : { present: false, key: null, source: null },
      config_files: files,
    })
  ) {
    return;
  }

  out(`profile: ${ctx.profileName} (${ctx.profileSource})`);
  out("");
  const rows = Object.entries(settings).map(([name, resolved]) => [
    name,
    formatValue(resolved.value),
    resolved.source,
  ]);
  out(renderTable(rows, { header: ["SETTING", "VALUE", "SOURCE"] }));
  out("");
  if (key !== undefined) {
    out(`api key: ${redactKey(key)} (from ${keySource ?? "unknown"})`);
  } else {
    out("api key: none found (checked --api-key, ENCONVERT_API_KEY, credential_helper, credentials.toml)");
  }
  out("");
  out("config files consulted:");
  for (const line of files) out(`  ${line}`);
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("read and write CLI configuration (user config file, per-profile)");

  config
    .command("get <key>")
    .description("print the resolved value of a setting")
    .addHelpText(
      "after",
      `
Keys: ${ALL_KEYS.join(", ")}

Examples:
  enconvert config get api_url
  enconvert config get color --json
`,
    )
    .action((key: string, _opts: Record<string, never>, cmd: Command) => getAction(key, cmd));

  config
    .command("set <key> <value>")
    .description("write a setting to the user config file (profile keys go under the active profile)")
    .addHelpText(
      "after",
      `
Keys: ${PROFILE_KEYS.join(", ")} (written under [profile.<active>])
      default_profile (top level)

Examples:
  enconvert config set api_url https://api-staging.enconvert.com
  enconvert config set concurrency 4
  enconvert -p ci config set credential_helper "op read op://eng/enconvert/api-key"
  enconvert config set default_profile staging
`,
    )
    .action((key: string, value: string, _opts: Record<string, never>, cmd: Command) =>
      setAction(key, value, cmd),
    );

  config
    .command("unset <key>")
    .description("remove a setting from the user config file")
    .addHelpText(
      "after",
      `
Examples:
  enconvert config unset credential_helper
  enconvert config unset default_profile
`,
    )
    .action((key: string, _opts: Record<string, never>, cmd: Command) => unsetAction(key, cmd));

  config
    .command("list")
    .description("print every resolved setting for the active profile")
    .addHelpText(
      "after",
      `
Examples:
  enconvert config list
  enconvert -p staging config list --json
`,
    )
    .action((_opts: Record<string, never>, cmd: Command) => listAction(cmd));

  config
    .command("edit")
    .description("open the user config file in $EDITOR (fallback vi)")
    .addHelpText(
      "after",
      `
Examples:
  enconvert config edit
  EDITOR="code --wait" enconvert config edit
`,
    )
    .action((_opts: Record<string, never>, cmd: Command) => editAction(cmd));

  config
    .command("path")
    .description("print the user config file path")
    .addHelpText(
      "after",
      `
Examples:
  cat "$(enconvert config path)"
`,
    )
    .action((_opts: Record<string, never>, cmd: Command) => pathAction(cmd));

  config
    .command("debug")
    .description("print every setting with its value AND where it came from (the support command)")
    .addHelpText(
      "after",
      `
Shows the active profile, each setting's provenance (flag/env/config file/default),
the API key source (redacted), and every config file consulted.

Examples:
  enconvert config debug
  enconvert config debug --json
`,
    )
    .action((_opts: Record<string, never>, cmd: Command) => debugAction(cmd));
}
