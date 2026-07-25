// `enconvert mcp install|uninstall <client>` and `enconvert mcp list`.
//
// The client registry is ported verbatim from mcp/src/cli/clients.ts (the
// @enconvert/mcp setup wizard) so both tools configure clients identically:
// same config paths, same entry shapes, same read-modify-write with a one-time
// `<file>.enconvert-backup`, and the same refuse-to-touch-unparseable rule —
// a config that exists but cannot be parsed (e.g. JSONC with comments) is
// never touched; install() throws and we print a manual snippet instead.
//
// No secrets are written into any client config: the MCP server reads the API
// key from ~/.enconvert/config.json (or the ENCONVERT_API_KEY env var).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Argument, type Command } from "commander";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { CliError, usageError } from "../api/errors.js";
import { info, out } from "../output/streams.js";
import { renderTable } from "../output/table.js";
import { contextFor } from "../program.js";
import { emitJson } from "./_shared.js";

const SERVER_NAME = "enconvert";
const PACKAGE_SPEC = "@enconvert/mcp@latest";

interface InstallOutcome {
  /** Where the entry was written ("claude CLI (user scope)" for the CLI path). */
  location: string;
  method: "file" | "claude-cli";
}

interface ClientDef {
  id: string;
  label: string;
  detect(): boolean;
  /** Human-readable target shown in prompts and status. */
  target(): string;
  isConfigured(): boolean;
  install(): InstallOutcome;
  /** Returns true when an entry was found and removed. */
  uninstall(): boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers (ported 1:1 from mcp/src/cli/clients.ts)
// ---------------------------------------------------------------------------

/** npx invocation for this platform (Windows needs the cmd shim). */
function commandShape(): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_SPEC] }
    : { command: "npx", args: ["-y", PACKAGE_SPEC] };
}

function appDataDir(): string {
  if (process.platform === "win32") {
    return process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
}

function backupOnce(path: string): void {
  const backup = `${path}.enconvert-backup`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
}

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`could not parse ${path} (comments or trailing commas?). Not touching it.`);
  }
}

function writeConfigFile(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  backupOnce(path);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function sectionOf(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = config[key];
  if (existing !== null && existing !== undefined && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  config[key] = fresh;
  return fresh;
}

/** Factory for JSON-config clients; only the entry shape and paths differ. */
function jsonClient(opts: {
  id: string;
  label: string;
  configPath: () => string;
  detectPath: () => string;
  /** Top-level key holding the server map (mcpServers / servers / ...). */
  sectionKey: string;
  entry: () => Record<string, unknown>;
}): ClientDef {
  return {
    id: opts.id,
    label: opts.label,
    detect: () => existsSync(opts.detectPath()),
    target: () => opts.configPath(),
    isConfigured: () => {
      try {
        const section = readConfigFile(opts.configPath())[opts.sectionKey];
        return !!section && typeof section === "object" && SERVER_NAME in (section as object);
      } catch {
        return false;
      }
    },
    install: () => {
      const path = opts.configPath();
      const config = readConfigFile(path);
      sectionOf(config, opts.sectionKey)[SERVER_NAME] = opts.entry();
      writeConfigFile(path, config);
      return { location: path, method: "file" };
    },
    uninstall: () => {
      const path = opts.configPath();
      if (!existsSync(path)) return false;
      const config = readConfigFile(path);
      const section = config[opts.sectionKey];
      if (!section || typeof section !== "object" || !(SERVER_NAME in (section as object))) {
        return false;
      }
      delete (section as Record<string, unknown>)[SERVER_NAME];
      writeConfigFile(path, config);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Claude Code — prefer the official CLI (handles ~/.claude.json safely).
// ---------------------------------------------------------------------------

function claudeCliAvailable(): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function claudeCodeClient(): ClientDef {
  const configPath = (): string => join(homedir(), ".claude.json");
  return {
    id: "claude-code",
    label: "Claude Code",
    detect: () => existsSync(configPath()) || existsSync(join(homedir(), ".claude")) || claudeCliAvailable(),
    target: () => (claudeCliAvailable() ? "claude CLI (user scope)" : configPath()),
    isConfigured: () => {
      try {
        const servers = readConfigFile(configPath())["mcpServers"];
        return !!servers && typeof servers === "object" && SERVER_NAME in (servers as object);
      } catch {
        return false;
      }
    },
    install: () => {
      const { command, args } = commandShape();
      if (claudeCliAvailable()) {
        const spec = JSON.stringify({ type: "stdio", command, args });
        const result = spawnSync("claude", ["mcp", "add-json", SERVER_NAME, spec, "-s", "user"], {
          stdio: "ignore",
        });
        if (result.status === 0) return { location: "claude CLI (user scope)", method: "claude-cli" };
        // Fall through to direct file edit if the CLI refused.
      }
      const path = configPath();
      const config = readConfigFile(path);
      sectionOf(config, "mcpServers")[SERVER_NAME] = { type: "stdio", command, args };
      writeConfigFile(path, config);
      return { location: path, method: "file" };
    },
    uninstall: () => {
      if (claudeCliAvailable()) {
        const result = spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"], {
          stdio: "ignore",
        });
        if (result.status === 0) return true;
      }
      const path = configPath();
      if (!existsSync(path)) return false;
      const config = readConfigFile(path);
      const servers = config["mcpServers"];
      if (!servers || typeof servers !== "object" || !(SERVER_NAME in (servers as object))) {
        return false;
      }
      delete (servers as Record<string, unknown>)[SERVER_NAME];
      writeConfigFile(path, config);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex — TOML config.
// ---------------------------------------------------------------------------

function codexClient(): ClientDef {
  const configPath = (): string => join(homedir(), ".codex", "config.toml");
  const read = (): Record<string, unknown> => {
    const path = configPath();
    if (!existsSync(path)) return {};
    try {
      return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`could not parse ${path}. Not touching it.`);
    }
  };
  return {
    id: "codex",
    label: "Codex CLI",
    detect: () => existsSync(join(homedir(), ".codex")),
    target: () => configPath(),
    isConfigured: () => {
      try {
        const servers = read()["mcp_servers"];
        return !!servers && typeof servers === "object" && SERVER_NAME in (servers as object);
      } catch {
        return false;
      }
    },
    install: () => {
      const path = configPath();
      const config = read();
      const { command, args } = commandShape();
      sectionOf(config, "mcp_servers")[SERVER_NAME] = { command, args };
      mkdirSync(dirname(path), { recursive: true });
      backupOnce(path);
      writeFileSync(path, stringifyToml(config) + "\n");
      return { location: path, method: "file" };
    },
    uninstall: () => {
      const path = configPath();
      if (!existsSync(path)) return false;
      const config = read();
      const servers = config["mcp_servers"];
      if (!servers || typeof servers !== "object" || !(SERVER_NAME in (servers as object))) {
        return false;
      }
      delete (servers as Record<string, unknown>)[SERVER_NAME];
      backupOnce(path);
      writeFileSync(path, stringifyToml(config) + "\n");
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function buildRegistry(): ClientDef[] {
  const std = commandShape();

  return [
    claudeCodeClient(),
    jsonClient({
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: () => join(appDataDir(), "Claude", "claude_desktop_config.json"),
      detectPath: () => join(appDataDir(), "Claude"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "cursor",
      label: "Cursor",
      configPath: () => join(homedir(), ".cursor", "mcp.json"),
      detectPath: () => join(homedir(), ".cursor"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "windsurf",
      label: "Windsurf",
      configPath: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
      detectPath: () => join(homedir(), ".codeium", "windsurf"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "vscode",
      label: "VS Code (Copilot)",
      configPath: () => join(appDataDir(), "Code", "User", "mcp.json"),
      detectPath: () => join(appDataDir(), "Code"),
      sectionKey: "servers",
      entry: () => ({ type: "stdio", command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "zed",
      label: "Zed",
      configPath: () =>
        process.platform === "win32"
          ? join(appDataDir(), "Zed", "settings.json")
          : join(homedir(), ".config", "zed", "settings.json"),
      detectPath: () =>
        process.platform === "win32" ? join(appDataDir(), "Zed") : join(homedir(), ".config", "zed"),
      sectionKey: "context_servers",
      entry: () => ({ source: "custom", command: std.command, args: std.args }),
    }),
    jsonClient({
      id: "gemini-cli",
      label: "Gemini CLI",
      configPath: () => join(homedir(), ".gemini", "settings.json"),
      detectPath: () => join(homedir(), ".gemini"),
      sectionKey: "mcpServers",
      entry: () => ({ command: std.command, args: std.args }),
    }),
    codexClient(),
    jsonClient({
      id: "opencode",
      label: "OpenCode",
      configPath: () => join(homedir(), ".config", "opencode", "opencode.json"),
      detectPath: () => join(homedir(), ".config", "opencode"),
      sectionKey: "mcp",
      entry: () => ({ type: "local", command: [std.command, ...std.args], enabled: true }),
    }),
  ];
}

/** Manual config snippet printed when a config cannot be edited safely. */
function manualSnippet(clientId: string): string {
  const { command, args } = commandShape();
  if (clientId === "codex") {
    return `[mcp_servers.${SERVER_NAME}]\ncommand = "${command}"\nargs = [${args.map((a) => `"${a}"`).join(", ")}]`;
  }
  if (clientId === "opencode") {
    return JSON.stringify(
      { mcp: { [SERVER_NAME]: { type: "local", command: [command, ...args], enabled: true } } },
      null,
      2,
    );
  }
  if (clientId === "vscode") {
    return JSON.stringify({ servers: { [SERVER_NAME]: { type: "stdio", command, args } } }, null, 2);
  }
  if (clientId === "zed") {
    return JSON.stringify({ context_servers: { [SERVER_NAME]: { source: "custom", command, args } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }, null, 2);
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

/** Plan-blessed short names on top of the registry ids. */
const CLIENT_ALIASES: Record<string, string> = {
  claude: "claude-code",
  gemini: "gemini-cli",
};

const CLIENT_CHOICES = [
  "claude",
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "windsurf",
  "vscode",
  "zed",
  "gemini",
  "gemini-cli",
  "opencode",
];

function resolveClient(name: string, registry: ClientDef[]): ClientDef {
  const id = CLIENT_ALIASES[name] ?? name;
  const client = registry.find((c) => c.id === id);
  if (client === undefined) {
    throw usageError(`unknown MCP client "${name}"`, {
      help: [`valid clients: ${CLIENT_CHOICES.join(", ")}`],
    });
  }
  return client;
}

function installFailure(client: ClientDef, cause: unknown): CliError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new CliError(message, {
    details: [`add this entry to ${client.target()} manually:`, ...manualSnippet(client.id).split("\n")],
    cause,
  });
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Manage the Enconvert MCP server in AI tools (Claude, Cursor, Codex, ...)")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  enconvert mcp install claude       add the server to Claude Code",
        "  enconvert mcp install cursor       add the server to Cursor",
        "  enconvert mcp list                 show detected clients and install status",
        "  enconvert mcp uninstall zed        remove the server entry from Zed",
        "",
        `Installs ${PACKAGE_SPEC} as a stdio server. No API key is written into any`,
        "client config; the server reads it from ~/.enconvert/config.json or",
        "the ENCONVERT_API_KEY environment variable.",
      ].join("\n"),
    );

  mcp
    .command("install")
    .description("Add the Enconvert MCP server to an AI client's config")
    .addArgument(new Argument("<client>", "AI client to configure").choices(CLIENT_CHOICES))
    .action((name: string, _opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const client = resolveClient(name, buildRegistry());
      if (ctx.opts.dryRun === true) {
        info(`would configure ${client.label} at ${client.target()} with:`);
        for (const line of manualSnippet(client.id).split("\n")) info(`  ${line}`);
        return;
      }
      let outcome: InstallOutcome;
      try {
        outcome = client.install();
      } catch (e) {
        throw installFailure(client, e);
      }
      if (!emitJson(ctx, { client: client.id, location: outcome.location, method: outcome.method })) {
        if (outcome.method === "file") out(outcome.location);
        info(
          outcome.method === "claude-cli"
            ? `configured ${client.label} via the claude CLI (user scope)`
            : `configured ${client.label}: ${outcome.location}`,
        );
        info(`restart ${client.label} to pick up the "${SERVER_NAME}" MCP server`);
      }
    });

  mcp
    .command("uninstall")
    .description("Remove the Enconvert MCP server entry from an AI client's config")
    .addArgument(new Argument("<client>", "AI client to clean up").choices(CLIENT_CHOICES))
    .action((name: string, _opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const client = resolveClient(name, buildRegistry());
      if (ctx.opts.dryRun === true) {
        info(`would remove the "${SERVER_NAME}" entry from ${client.target()}`);
        return;
      }
      let removed: boolean;
      try {
        removed = client.uninstall();
      } catch (e) {
        throw installFailure(client, e);
      }
      if (!emitJson(ctx, { client: client.id, removed })) {
        info(
          removed
            ? `removed the "${SERVER_NAME}" entry from ${client.label}`
            : `no "${SERVER_NAME}" entry found for ${client.label}`,
        );
      }
    });

  mcp
    .command("list")
    .description("Show MCP install status for every supported AI client")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const rows = buildRegistry().map((client) => ({
        client: client.id,
        name: client.label,
        detected: client.detect(),
        configured: client.isConfigured(),
        config: client.target(),
      }));
      if (emitJson(ctx, rows)) return;
      out(
        renderTable(
          rows.map((r) => [r.client, r.detected ? "yes" : "no", r.configured ? "yes" : "no", r.config]),
          { header: ["CLIENT", "DETECTED", "CONFIGURED", "CONFIG"] },
        ),
      );
    });
}
