// Meta commands: whoami, status, usage, version, docs, open.
// `status` is informational and always exits 0 — degraded or unreachable is
// news the user asked for, not a CLI failure.
import { spawn } from "node:child_process";
import type { Command } from "commander";
import { Argument } from "commander";
import { ApiError } from "../api/errors.js";
import { authVerify, health, whoami } from "../api/v1.js";
import { out, info, warn } from "../output/streams.js";
import { readInstallMethod } from "../util/update-notifier.js";
import { VERSION } from "../version.js";
import { contextFor } from "../program.js";
import { emitJson } from "./_shared.js";

const DOCS_URL = "https://enconvert.com/docs/cli";
const DASHBOARD_USAGE_URL = "https://enconvert.com/dashboard/usage";

const OPEN_TARGETS: Record<string, string> = {
  dashboard: "https://enconvert.com/dashboard",
  billing: "https://enconvert.com/dashboard/billing",
  docs: DOCS_URL,
};

/** Best-effort detached browser launch; the URL is always printed first. */
function openInBrowser(url: string): void {
  try {
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    // Swallow the async ENOENT a headless box raises — the printed URL is the
    // fallback for SSH sessions where no opener exists.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore: the URL is on stdout for the user to copy.
  }
}

async function whoamiAction(cmd: Command): Promise<void> {
  const ctx = contextFor(cmd);
  const identity = await whoami(ctx);
  if (emitJson(ctx, identity)) return;
  out(`project ${identity.project_id} on the ${identity.plan_slug} plan`);
}

async function statusAction(cmd: Command): Promise<void> {
  const ctx = contextFor(cmd);

  let healthBody: Record<string, unknown>;
  let healthStatus: number | undefined;
  try {
    const res = await health(ctx);
    healthStatus = res.status;
    healthBody = res.body;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    healthBody = { status: "unreachable", error: reason };
  }

  let auth: Record<string, unknown> | null = null;
  let authError: string | undefined;
  const key = ctx.tryApiKey();
  if (key !== undefined) {
    try {
      auth = await authVerify(ctx);
    } catch (e) {
      authError = e instanceof ApiError ? `HTTP ${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e);
    }
  }

  if (emitJson(ctx, { health: healthBody, auth })) return;

  const gatewayState = typeof healthBody["status"] === "string" ? (healthBody["status"] as string) : "unknown";
  if (gatewayState === "healthy") {
    out(`gateway: healthy${healthStatus !== undefined ? ` (HTTP ${healthStatus})` : ""}`);
  } else if (gatewayState === "unreachable") {
    out(`gateway: UNREACHABLE — ${String(healthBody["error"] ?? "unknown error")}`);
  } else {
    out(`gateway: DEGRADED${healthStatus !== undefined ? ` (HTTP ${healthStatus})` : ""} — some checks are failing`);
  }
  const checks = healthBody["checks"];
  if (checks !== null && typeof checks === "object" && !Array.isArray(checks)) {
    for (const [name, value] of Object.entries(checks as Record<string, unknown>)) {
      out(`  ${name}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
  }
  if (key === undefined) {
    out("auth: no API key configured (run `enconvert auth login`)");
  } else if (auth !== null) {
    const tier = typeof auth["tier"] === "string" ? auth["tier"] : "?";
    const keyType = typeof auth["key_type"] === "string" ? auth["key_type"] : "?";
    out(`auth: authenticated as project ${String(auth["project_id"] ?? "?")} (tier ${tier}, ${keyType} key)`);
  } else {
    out(`auth: FAILED — ${authError ?? "unknown error"}`);
  }
}

async function usageAction(cmd: Command): Promise<void> {
  const ctx = contextFor(cmd);
  // The gateway has no usage endpoint; report what /v1/whoami and
  // /v1/auth/verify DO expose and point at the dashboard for the counters.
  const identity = await whoami(ctx);
  let verify: Record<string, unknown> | undefined;
  try {
    verify = await authVerify(ctx);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    warn(`could not fetch key details from /v1/auth/verify: ${reason}`);
  }

  const payload: Record<string, unknown> = {
    project_id: identity.project_id,
    plan_slug: identity.plan_slug,
    ...(verify !== undefined
      ? { tier: verify["tier"] ?? null, key_type: verify["key_type"] ?? null }
      : {}),
    usage_counters: null,
    note: "the gateway does not expose usage counters over the API; see the dashboard",
    dashboard_url: DASHBOARD_USAGE_URL,
  };
  if (emitJson(ctx, payload)) return;

  out(`project: ${identity.project_id}`);
  out(`plan: ${identity.plan_slug}`);
  if (verify !== undefined) {
    if (verify["tier"] !== undefined) out(`tier: ${String(verify["tier"])}`);
    if (verify["key_type"] !== undefined) out(`key type: ${String(verify["key_type"])}`);
  }
  out("");
  out("the gateway does not expose usage counters over the API yet.");
  out(`conversion and quota numbers live at ${DASHBOARD_USAGE_URL}`);
}

function versionAction(cmd: Command): void {
  const ctx = contextFor(cmd);
  const installMethod = readInstallMethod();
  if (
    emitJson(ctx, {
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      install_method: installMethod ?? null,
    })
  ) {
    return;
  }
  out(`enconvert ${VERSION} (${process.platform}-${process.arch})`);
  if (installMethod !== undefined) out(`installed via: ${installMethod}`);
}

function docsAction(query: string[], cmd: Command): void {
  const ctx = contextFor(cmd);
  const q = query.join(" ").trim();
  const url = q !== "" ? `https://enconvert.com/docs/search?q=${encodeURIComponent(q)}` : DOCS_URL;
  if (emitJson(ctx, { url })) {
    openInBrowser(url);
    return;
  }
  // URL on stdout so SSH users (no local browser) can copy it.
  out(url);
  openInBrowser(url);
  info("opening in your browser...");
}

function openAction(target: string, cmd: Command): void {
  const ctx = contextFor(cmd);
  const url = OPEN_TARGETS[target];
  if (url === undefined) {
    // Unreachable behind Argument.choices(); defensive for direct callers.
    throw new Error(`unknown open target: ${target}`);
  }
  if (emitJson(ctx, { url })) {
    openInBrowser(url);
    return;
  }
  out(url);
  openInBrowser(url);
  info("opening in your browser...");
}

export function registerMetaCommands(program: Command): void {
  program
    .command("whoami")
    .description("print the project and plan behind the active API key (GET /v1/whoami)")
    .addHelpText(
      "after",
      `
Examples:
  enconvert whoami
  enconvert whoami --json    # {"project_id": "...", "plan_slug": "pro"}
`,
    )
    .action(async (_opts: Record<string, never>, cmd: Command) => whoamiAction(cmd));

  program
    .command("status")
    .description("gateway health plus an auth check; informational, always exits 0")
    .addHelpText(
      "after",
      `
Checks GET /health (works without a key) and, when a key is configured,
GET /v1/auth/verify.

Examples:
  enconvert status
  enconvert status --json    # {"health": {...}, "auth": {...}}
`,
    )
    .action(async (_opts: Record<string, never>, cmd: Command) => statusAction(cmd));

  program
    .command("usage")
    .description("plan and key details; usage counters live in the dashboard")
    .addHelpText(
      "after",
      `
The gateway exposes no usage endpoint, so this prints what /v1/whoami and
/v1/auth/verify return and points at ${DASHBOARD_USAGE_URL}
for the actual counters.

Examples:
  enconvert usage
  enconvert usage --json
`,
    )
    .action(async (_opts: Record<string, never>, cmd: Command) => usageAction(cmd));

  program
    .command("version")
    .description("print the CLI version, platform, and install method")
    .addHelpText(
      "after",
      `
Examples:
  enconvert version
  enconvert version --json
`,
    )
    .action((_opts: Record<string, never>, cmd: Command) => versionAction(cmd));

  program
    .command("docs [query...]")
    .description("open the CLI docs (or a docs search) in your browser")
    .addHelpText(
      "after",
      `
The URL is always printed to stdout so it can be copied from an SSH session.

Examples:
  enconvert docs
  enconvert docs pdf options
`,
    )
    .action((query: string[], _opts: Record<string, never>, cmd: Command) => docsAction(query, cmd));

  program
    .command("open")
    .description("open the Enconvert dashboard, billing, or docs in your browser")
    .addArgument(
      new Argument("[target]", "what to open").choices(Object.keys(OPEN_TARGETS)).default("dashboard"),
    )
    .addHelpText(
      "after",
      `
Examples:
  enconvert open              # dashboard
  enconvert open billing
  enconvert open docs
`,
    )
    .action((target: string, _opts: Record<string, never>, cmd: Command) => openAction(target, cmd));
}
