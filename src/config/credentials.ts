// Credential storage: ~/.config/enconvert/credentials.toml, file mode 0600,
// directory 0700. Shape:
//
//   [profile.default]
//   api_key = "sk_..."
//
// Read-migration: @enconvert/mcp stores {"api_key": "..."} in
// ~/.enconvert/config.json — a user who ran `npx @enconvert/mcp setup` must not
// have to paste their key again.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { CliError, EXIT } from "../api/errors.js";
import { credentialsFilePath, legacyMcpCredentialsPath } from "./paths.js";

interface CredentialsFile {
  profile?: Record<string, { api_key?: string }>;
}

export function isValidKeyFormat(key: string): boolean {
  return /^(sk|pk)_/.test(key) && key.length >= 45;
}

/** sk_…abcd — the only form a key may ever take in output, including --debug. */
export function redactKey(key: string): string {
  if (key.length < 8) return "***";
  const prefix = key.startsWith("sk_") || key.startsWith("pk_") ? key.slice(0, 3) : "";
  return `${prefix}…${key.slice(-4)}`;
}

function readCredentialsFile(): CredentialsFile {
  const path = credentialsFilePath();
  if (!existsSync(path)) return {};
  try {
    return parseToml(readFileSync(path, "utf8")) as CredentialsFile;
  } catch {
    throw new CliError(`could not parse ${path}`, {
      help: ["fix or delete the file, then run `enconvert auth login` again"],
    });
  }
}

export function getStoredKey(profileName: string): { key: string; path: string } | undefined {
  const creds = readCredentialsFile();
  const key = creds.profile?.[profileName]?.api_key;
  if (key !== undefined && key !== "") return { key, path: credentialsFilePath() };
  return undefined;
}

/** Legacy @enconvert/mcp store: ~/.enconvert/config.json {"api_key": ...}. */
export function getLegacyMcpKey(): { key: string; path: string } | undefined {
  const path = legacyMcpCredentialsPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { api_key?: string };
    if (typeof parsed.api_key === "string" && parsed.api_key.trim() !== "") {
      return { key: parsed.api_key.trim(), path };
    }
  } catch {
    // Unparseable legacy file: ignore, never block.
  }
  return undefined;
}

export function writeStoredKey(profileName: string, key: string): string {
  const path = credentialsFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const creds = existsSync(path) ? readCredentialsFile() : {};
  creds.profile = creds.profile ?? {};
  creds.profile[profileName] = { ...creds.profile[profileName], api_key: key };
  writeFileSync(path, stringifyToml(creds as Record<string, unknown>) + "\n", { mode: 0o600 });
  // writeFileSync mode only applies at creation; enforce on overwrite too.
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

export function deleteStoredKey(profileName: string): boolean {
  const path = credentialsFilePath();
  if (!existsSync(path)) return false;
  const creds = readCredentialsFile();
  if (creds.profile?.[profileName]?.api_key === undefined) return false;
  delete creds.profile[profileName];
  if (Object.keys(creds.profile).length === 0) {
    unlinkSync(path);
  } else {
    writeFileSync(path, stringifyToml(creds as Record<string, unknown>) + "\n", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(path, 0o600);
  }
  return true;
}

/** Run a `credential_helper` command from config; its stdout (trimmed) is the key. */
export function runCredentialHelper(command: string): string {
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new CliError(`credential_helper failed: ${command}`, {
      exitCode: EXIT.AUTH,
      details: [(result.stderr ?? "").trim() || `exit status ${result.status ?? "unknown"}`],
    });
  }
  const key = result.stdout.trim();
  if (key === "") {
    throw new CliError(`credential_helper produced no output: ${command}`, { exitCode: EXIT.AUTH });
  }
  return key;
}
