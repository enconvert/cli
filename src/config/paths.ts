// Path resolution. ~/.config on macOS AND Linux (gh/stripe/kubectl convention),
// %APPDATA% on Windows. XDG_*_HOME honoured; relative or empty values ignored.
// ENCONVERT_CONFIG_DIR overrides the whole config tree.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function xdg(name: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value !== undefined && value !== "" && isAbsolute(value)) return value;
  return fallback;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ENCONVERT_CONFIG_DIR"];
  if (override !== undefined && override !== "") return override;
  if (process.platform === "win32") {
    return join(env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "enconvert");
  }
  return join(xdg("XDG_CONFIG_HOME", join(homedir(), ".config"), env), "enconvert");
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.toml");
}

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.toml");
}

export function systemConfigPath(): string | null {
  if (process.platform === "win32") return null;
  return "/etc/enconvert/config.toml";
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "enconvert", "cache");
  }
  return join(xdg("XDG_CACHE_HOME", join(homedir(), ".cache"), env), "enconvert");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "enconvert", "state");
  }
  return join(xdg("XDG_STATE_HOME", join(homedir(), ".local", "state"), env), "enconvert");
}

/** Legacy @enconvert/mcp credential store, read-migrated on first use. */
export function legacyMcpCredentialsPath(): string {
  return join(homedir(), ".enconvert", "config.json");
}

/** Written by install.sh / install.ps1 so `enconvert upgrade` can delegate. */
export function installMethodPath(): string {
  return join(homedir(), ".enconvert", "install-method");
}

export const PROJECT_CONFIG_FILENAME = ".enconvertrc.toml";
