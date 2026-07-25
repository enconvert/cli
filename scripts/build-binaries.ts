// Compiles the 7 standalone `enconvert` binaries with `bun build --compile`.
//
//   npx tsx scripts/build-binaries.ts                          # all 7 targets
//   npx tsx scripts/build-binaries.ts --target bun-darwin-arm64
//
// Output layout (one staging dir per target, ready to be archived as-is):
//   dist-bin/<bun-target>/enconvert[.exe]
//   dist-bin/<bun-target>/LICENSE
//   dist-bin/<bun-target>/README.md
//   dist-bin/<bun-target>/completions/*        (when completions exist)
//
// Standing rules encoded here (learned the hard way — see IMPLEMENTATION-PLAN.md
// "Distribution"):
//   * Bun compiles straight from src/cli.ts — no tsdown/npm build step needed.
//     Only scripts/sync-version.mjs must run first so src/version.ts carries the
//     package.json version as a compile-time constant.
//   * BUN_NO_CODESIGN_MACHO_BINARY=1 on darwin targets: bun's own Mach-O signer
//     produced a truncated SuperBlob in 1.3.12 (oven-sh/bun#29120) which the
//     arm64 macOS kernel answers with SIGKILL. We strip bun's signature and
//     re-sign ourselves — rcodesign in CI, ad-hoc `codesign -s -` locally.
//   * No --windows-icon / --windows-version: both are unsupported when
//     cross-compiling to bun-windows-x64. A plain .exe is accepted.
//   * --bytecode (~2x startup) and --minify are always on.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALL_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-windows-x64",
] as const;
type BunTarget = (typeof ALL_TARGETS)[number];

function usage(): void {
  console.log(
    [
      "Usage: tsx scripts/build-binaries.ts [--target <bun-target>]...",
      "",
      "Without --target, all 7 targets are built:",
      ...ALL_TARGETS.map((t) => `  ${t}`),
    ].join("\n"),
  );
}

function parseTargets(argv: string[]): BunTarget[] {
  const picked: BunTarget[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--target") {
      const value = argv[++i];
      if (!value || !(ALL_TARGETS as readonly string[]).includes(value)) {
        console.error(`error: unknown target ${JSON.stringify(value ?? "")}`);
        usage();
        process.exit(2);
      }
      picked.push(value as BunTarget);
      continue;
    }
    console.error(`error: unknown argument ${JSON.stringify(arg)}`);
    usage();
    process.exit(2);
  }
  return picked.length > 0 ? picked : [...ALL_TARGETS];
}

function findBun(): string {
  // PATH first, then the default install location (CI puts setup-bun on PATH;
  // local machines often have only ~/.bun/bin/bun).
  const candidates = ["bun", join(homedir(), ".bun", "bin", "bun")];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      console.error(`using bun ${probe.stdout.trim()} (${candidate})`);
      return candidate;
    }
  }
  console.error("error: bun not found on PATH or at ~/.bun/bin/bun — install from https://bun.sh");
  process.exit(1);
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`error: ${command} ${args.join(" ")} exited ${String(result.status)}`);
    process.exit(1);
  }
  return result;
}

function stageSupportFiles(outDir: string): void {
  // Ship license + docs + completions inside every archive so a tarball user
  // gets the same experience as a package-manager user.
  for (const file of ["LICENSE", "README.md"]) {
    const src = join(repoRoot, file);
    if (existsSync(src)) cpSync(src, join(outDir, file));
  }
  const completionsDir = join(repoRoot, "completions");
  if (existsSync(completionsDir) && readdirSync(completionsDir).length > 0) {
    cpSync(completionsDir, join(outDir, "completions"), { recursive: true });
  }
}

function adHocSignIfLocalDarwin(target: BunTarget, binaryPath: string): void {
  // BUN_NO_CODESIGN_MACHO_BINARY=1 leaves darwin binaries UNSIGNED, and the
  // arm64 macOS kernel SIGKILLs unsigned Mach-Os. CI re-signs with rcodesign;
  // for local builds on a Mac we ad-hoc sign so the artifact is runnable.
  if (!target.startsWith("bun-darwin") || process.platform !== "darwin") return;
  const probe = spawnSync("codesign", ["--version"], { encoding: "utf8" });
  if (probe.error) {
    console.error("warning: codesign not available — darwin binary left unsigned (will SIGKILL on arm64)");
    return;
  }
  run("codesign", ["--sign", "-", "--force", binaryPath]);
  console.error(`ad-hoc signed ${binaryPath}`);
}

function buildTarget(bun: string, target: BunTarget): string {
  const outDir = join(repoRoot, "dist-bin", target);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const binaryName = target === "bun-windows-x64" ? "enconvert.exe" : "enconvert";
  const outfile = join(outDir, binaryName);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (target.startsWith("bun-darwin")) {
    // See header comment: strip bun's signer (oven-sh/bun#29120); we re-sign.
    env["BUN_NO_CODESIGN_MACHO_BINARY"] = "1";
  }

  console.error(`\n== ${target}`);
  run(
    bun,
    [
      "build",
      "./src/cli.ts",
      "--compile",
      "--bytecode",
      "--minify",
      `--target=${target}`,
      "--outfile",
      outfile,
    ],
    env,
  );

  if (!existsSync(outfile)) {
    console.error(`error: expected output missing: ${outfile}`);
    process.exit(1);
  }
  adHocSignIfLocalDarwin(target, outfile);
  stageSupportFiles(outDir);
  return outfile;
}

function main(): void {
  const targets = parseTargets(process.argv.slice(2));

  // src/version.ts must match package.json before bun bundles it.
  run(process.execPath, [join(repoRoot, "scripts", "sync-version.mjs")]);

  const bun = findBun();
  const built: Array<{ target: BunTarget; path: string; bytes: number }> = [];
  for (const target of targets) {
    const path = buildTarget(bun, target);
    built.push({ target, path, bytes: statSync(path).size });
  }

  console.error("\nbuilt binaries:");
  for (const item of built) {
    const mb = (item.bytes / (1024 * 1024)).toFixed(1);
    console.error(`  ${item.target.padEnd(24)} ${mb.padStart(7)} MB  ${item.path}`);
  }
}

main();
