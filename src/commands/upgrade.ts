// `enconvert upgrade` — the gh model: read ~/.enconvert/install-method and
// delegate to the owning package manager, or self-update standalone binaries
// (download from GitHub releases, verify sha256, atomic rename over execPath).
// The exact command being run is ALWAYS printed first; --dry-run stops there.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import type { Command } from "commander";
import { CliError, networkError, unsupportedError } from "../api/errors.js";
import { info } from "../output/streams.js";
import { contextFor, type Context } from "../program.js";
import { readInstallMethod } from "../util/update-notifier.js";
import { USER_AGENT, VERSION } from "../version.js";
import { emitJson } from "./_shared.js";

const LATEST_URL = "https://get.enconvert.com/latest-version";
const RELEASE_BASE = "https://github.com/enconvert/cli/releases/download";

const CHANNEL_COMMANDS: Record<string, string[]> = {
  brew: ["brew", "upgrade", "--cask", "enconvert/tap/enconvert"],
  scoop: ["scoop", "update", "enconvert"],
  npm: ["npm", "install", "-g", "@enconvert/cli@latest"],
};

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/** Best-effort guess when install.sh never wrote ~/.enconvert/install-method. */
function detectInstallMethod(): string | undefined {
  const execPath = process.execPath;
  if (/[/\\](Cellar|Caskroom)[/\\]/.test(execPath) || execPath.includes("/homebrew/")) return "brew";
  if (/scoop/i.test(execPath)) return "scoop";
  if (execPath.includes(`${sep}node_modules${sep}`) || basename(execPath).startsWith("node")) return "npm";
  return undefined;
}

function delegate(ctx: Context, parts: string[]): void {
  info(`running: ${parts.join(" ")}`);
  if (ctx.opts.dryRun === true) return;
  const result = spawnSync(parts[0]!, parts.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) {
    throw new CliError(`could not run ${parts[0]}: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new CliError(`${parts[0]} exited with status ${result.status ?? "unknown"}`);
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT } });
  } catch (e) {
    throw networkError(`could not reach ${url}`, { cause: e });
  }
  if (!res.ok) throw networkError(`HTTP ${res.status} from ${url}`);
  return res.text();
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT } });
  } catch (e) {
    throw networkError(`download failed: ${url}`, { cause: e });
  }
  if (!res.ok) throw networkError(`download failed with HTTP ${res.status}: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Release archive target triple, matching the goreleaser naming scheme. */
function releaseTarget(): { os: string; arch: string; musl: boolean; ext: string } {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : null;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (os === null || arch === null) {
    throw unsupportedError(`no prebuilt binary for ${process.platform}/${process.arch}`, {
      help: ["install from npm instead: npm install -g @enconvert/cli@latest"],
    });
  }
  // A glibc runtime absent from the process report means musl (Alpine et al).
  const report = process.report?.getReport() as unknown as { header?: { glibcVersionRuntime?: string } } | undefined;
  const musl = os === "linux" && report?.header?.glibcVersionRuntime === undefined;
  return { os, arch, musl, ext: os === "windows" ? "zip" : "tar.gz" };
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** checksums.txt lines: "<sha256>  <filename>" (optionally "*<filename>"). */
function expectedChecksum(checksums: string, archiveName: string): string {
  for (const line of checksums.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[1]!.replace(/^\*/, "");
    if (name === archiveName) return parts[0]!.toLowerCase();
  }
  throw new CliError(`no entry for ${archiveName} in the release checksums file`);
}

/** Find the extracted `enconvert` binary at the extract root or one level down. */
function findExtractedBinary(dir: string): string | null {
  const wanted = process.platform === "win32" ? "enconvert.exe" : "enconvert";
  const direct = join(dir, wanted);
  try {
    if (statSync(direct).isFile()) return direct;
  } catch {
    // keep scanning
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(dir, entry.name, wanted);
    try {
      if (statSync(nested).isFile()) return nested;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function replaceExecutable(newBinary: string, target: string): void {
  const stage = `${target}.new`;
  try {
    copyFileSync(newBinary, stage);
    chmodSync(stage, 0o755);
    renameSync(stage, target);
  } catch (e) {
    try {
      unlinkSync(stage);
    } catch {
      // stage file may not exist
    }
    throw new CliError(`cannot replace ${target} (${(e as NodeJS.ErrnoException).code ?? "write failed"})`, {
      help: [
        "the binary location is not writable by this user",
        "re-run your original installer, e.g.: curl -fsSL https://get.enconvert.com/install.sh | sh",
      ],
      cause: e,
    });
  }
}

async function selfUpdate(ctx: Context): Promise<void> {
  info(`current version: v${VERSION}`);
  const latest = (await fetchText(LATEST_URL, 10_000)).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+/.test(latest)) {
    throw networkError(`unexpected latest-version payload from ${LATEST_URL}`);
  }
  if (!isNewer(latest, VERSION)) {
    if (!emitJson(ctx, { current: VERSION, latest, up_to_date: true })) {
      info(`already up to date (v${VERSION})`);
    }
    return;
  }

  const target = releaseTarget();
  const archiveName = `enconvert_${latest}_${target.os}_${target.arch}${target.musl ? "_musl" : ""}.${target.ext}`;
  const checksumsName = `enconvert_${latest}_checksums.txt`;
  const archiveUrl = `${RELEASE_BASE}/v${latest}/${archiveName}`;
  const checksumsUrl = `${RELEASE_BASE}/v${latest}/${checksumsName}`;

  info(`upgrading v${VERSION} -> v${latest}`);
  info(`download: ${archiveUrl}`);
  info(`verify:   ${checksumsUrl}`);
  if (ctx.opts.dryRun === true) {
    info(`would verify sha256, extract, and replace ${process.execPath}`);
    return;
  }

  if (basename(process.execPath).startsWith("node")) {
    // install-method claimed a standalone binary but we are running under node.
    throw new CliError("this CLI is running under node, not as a standalone binary", {
      help: ["upgrade with your package manager instead: npm install -g @enconvert/cli@latest"],
    });
  }

  const workDir = mkdtempSync(join(tmpdir(), "enconvert-upgrade-"));
  try {
    const archive = await fetchBytes(archiveUrl, 300_000);
    const checksums = await fetchText(checksumsUrl, 30_000);
    const expected = expectedChecksum(checksums, archiveName);
    const actual = sha256Hex(archive);
    if (actual !== expected) {
      throw new CliError(`sha256 mismatch for ${archiveName}`, {
        details: [`expected ${expected}`, `got      ${actual}`],
        help: ["the download may be corrupted or tampered with; retry, and report persistent failures"],
      });
    }
    info(`sha256 verified (${expected.slice(0, 12)}...)`);

    const archivePath = join(workDir, archiveName);
    writeFileSync(archivePath, archive);

    if (target.ext === "zip") {
      // No zip extractor is bundled; hand the verified archive to the user.
      info("automatic extraction of .zip archives is not supported on Windows; finish manually:");
      info(`  1. expand ${archivePath}`);
      info(`  2. replace ${process.execPath} with the extracted enconvert.exe`);
      return;
    }

    const tar = spawnSync("tar", ["-xzf", archivePath, "-C", workDir], { stdio: "ignore" });
    if (tar.error !== undefined || tar.status !== 0) {
      throw new CliError(`could not extract ${archiveName} with tar`, {
        help: [`extract it manually: tar -xzf ${archivePath}`],
        ...(tar.error !== undefined ? { cause: tar.error } : {}),
      });
    }
    const binary = findExtractedBinary(workDir);
    if (binary === null) {
      throw new CliError(`no enconvert binary found inside ${archiveName}`);
    }
    replaceExecutable(binary, process.execPath);
    if (!emitJson(ctx, { upgraded: true, from: VERSION, to: latest, path: process.execPath })) {
      info(`upgraded enconvert v${VERSION} -> v${latest} (${process.execPath})`);
    }
  } finally {
    // The verified zip must survive for the manual Windows path.
    if (target.ext !== "zip") rmSync(workDir, { recursive: true, force: true });
  }
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade the Enconvert CLI via the channel it was installed from")
    .addHelpText(
      "after",
      [
        "",
        "Reads ~/.enconvert/install-method (written by install.sh) and delegates:",
        "  brew            brew upgrade --cask enconvert/tap/enconvert",
        "  scoop           scoop update enconvert",
        "  npm             npm install -g @enconvert/cli@latest",
        "  install-script  self-update: download the release archive, verify",
        "  / binary        sha256, and atomically replace the current binary",
        "",
        "The command being run is always printed first. Use -n/--dry-run to only",
        "print what would happen. Nothing is ever updated silently.",
      ].join("\n"),
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const recorded = readInstallMethod();
      const method = recorded ?? detectInstallMethod();
      if (recorded === undefined) {
        info(
          method === undefined
            ? "no ~/.enconvert/install-method file and no channel detected"
            : `no ~/.enconvert/install-method file; detected "${method}" from ${process.execPath}`,
        );
      }

      const channel = method !== undefined ? CHANNEL_COMMANDS[method] : undefined;
      if (channel !== undefined) {
        delegate(ctx, channel);
        return;
      }
      if (method === "install-script" || method === "binary") {
        await selfUpdate(ctx);
        return;
      }
      throw new CliError(
        method === undefined ? "cannot determine how this CLI was installed" : `unknown install method "${method}"`,
        {
          details: [
            "upgrade with whichever channel you installed from:",
            "  brew upgrade --cask enconvert/tap/enconvert",
            "  scoop update enconvert",
            "  npm install -g @enconvert/cli@latest",
            "  curl -fsSL https://get.enconvert.com/install.sh | sh",
          ],
        },
      );
    });
}
