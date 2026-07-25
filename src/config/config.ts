// TOML config load/validate/save. Precedence handling lives in resolve.ts.
//
// Files consulted (unless --config <path> is given, which replaces the stack):
//   project  ./.enconvertrc.toml (walking up from cwd)
//   user     ~/.config/enconvert/config.toml
//   system   /etc/enconvert/config.toml
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { CliError } from "../api/errors.js";
import { PROJECT_CONFIG_FILENAME, systemConfigPath, userConfigPath } from "./paths.js";

export const ProfileSchema = z.looseObject({
  api_url: z.string().optional(),
  color: z.enum(["auto", "always", "never"]).optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  timeout: z.union([z.string(), z.number()]).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  credential_helper: z.string().optional(),
});
export type ProfileConfig = z.infer<typeof ProfileSchema>;

export const ConfigFileSchema = z.looseObject({
  default_profile: z.string().optional(),
  profile: z.record(z.string(), ProfileSchema).optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface LoadedConfig {
  path: string;
  config: ConfigFile;
}

export function loadConfigFile(path: string): LoadedConfig | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (e) {
    throw new CliError(`invalid TOML in ${path}`, {
      details: [e instanceof Error ? e.message : String(e)],
      help: [`fix the file, or move it aside and re-run`],
    });
  }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(`invalid configuration in ${path}`, {
      details: z.prettifyError(result.error).split("\n"),
    });
  }
  return { path, config: result.data };
}

/** Walk up from startDir looking for .enconvertrc.toml. */
export function findProjectConfig(startDir: string): string | null {
  let dir = startDir;
  const { root } = parsePath(startDir);
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

export interface ConfigStack {
  /** --config <path>: replaces the whole stack when present. */
  explicit?: LoadedConfig;
  project?: LoadedConfig;
  user?: LoadedConfig;
  system?: LoadedConfig;
}

export function loadConfigStack(opts: { explicitPath?: string; cwd?: string } = {}): ConfigStack {
  if (opts.explicitPath !== undefined) {
    const explicit = loadConfigFile(opts.explicitPath);
    if (explicit === null) {
      throw new CliError(`config file not found: ${opts.explicitPath}`, {
        exitCode: 3,
      });
    }
    return { explicit };
  }
  const stack: ConfigStack = {};
  const projectPath = findProjectConfig(opts.cwd ?? process.cwd());
  if (projectPath !== null) stack.project = loadConfigFile(projectPath) ?? undefined;
  stack.user = loadConfigFile(userConfigPath()) ?? undefined;
  const sysPath = systemConfigPath();
  if (sysPath !== null) stack.system = loadConfigFile(sysPath) ?? undefined;
  return stack;
}

/** Ordered highest-precedence first, for per-setting resolution. */
export function stackLayers(stack: ConfigStack): Array<{ label: string; loaded: LoadedConfig }> {
  if (stack.explicit) return [{ label: `config ${stack.explicit.path}`, loaded: stack.explicit }];
  const layers: Array<{ label: string; loaded: LoadedConfig }> = [];
  if (stack.project) layers.push({ label: `project ${stack.project.path}`, loaded: stack.project });
  if (stack.user) layers.push({ label: `user ${stack.user.path}`, loaded: stack.user });
  if (stack.system) layers.push({ label: `system ${stack.system.path}`, loaded: stack.system });
  return layers;
}

export function saveUserConfig(config: ConfigFile): string {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyToml(config) + "\n");
  return path;
}
