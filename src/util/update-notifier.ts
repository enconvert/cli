// The gh-model update nag: <= 1 check per 24 h, cached to the state dir,
// printed to stderr AFTER the command's output, never blocking, and skipped
// when CI is set, ENCONVERT_NO_UPDATE_NOTIFIER is set, or either stdout or
// stderr is not a TTY. The "latest" pointer is a static file on
// get.enconvert.com (no GitHub API rate limit, proxy-friendly).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config/paths.js";
import { c } from "../output/color.js";
import { VERSION } from "../version.js";

const CHECK_URL = "https://get.enconvert.com/latest-version";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  checked_at: number;
  latest: string;
}

function cachePath(): string {
  return join(stateDir(), "update-check.json");
}

function readCache(): UpdateCache | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as UpdateCache;
  } catch {
    return undefined;
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

export function updateNagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["CI"] !== undefined && env["CI"] !== "") return false;
  if (env["ENCONVERT_NO_UPDATE_NOTIFIER"] !== undefined) return false;
  return Boolean(process.stdout.isTTY) && Boolean(process.stderr.isTTY);
}

/**
 * Fire-and-forget. Returns the nag line to print (caller prints it AFTER the
 * command's own output) or null. Never throws; 1500 ms network budget.
 */
export async function checkForUpdate(): Promise<string | null> {
  if (!updateNagEnabled()) return null;
  let cache = readCache();
  const now = Date.now();
  if (cache === undefined || now - cache.checked_at > CHECK_INTERVAL_MS) {
    try {
      const res = await fetch(CHECK_URL, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const latest = (await res.text()).trim().replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+/.test(latest)) return null;
      cache = { checked_at: now, latest };
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), JSON.stringify(cache) + "\n");
    } catch {
      return null;
    }
  }
  if (cache !== undefined && isNewer(cache.latest, VERSION)) {
    const pc = c();
    return `${pc.dim(`enconvert ${VERSION} -> ${cache.latest} available.`)} ${pc.dim("run `enconvert upgrade`")}`;
  }
  return null;
}

/** install.sh writes ~/.enconvert/install-method so `upgrade` can delegate. */
export function readInstallMethod(): string | undefined {
  const path = join(process.env["HOME"] ?? "", ".enconvert", "install-method");
  try {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  } catch {
    // ignore
  }
  return undefined;
}
