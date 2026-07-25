// Build-time completion generation: writes completions/enconvert.bash,
// _enconvert (zsh), enconvert.fish and _enconvert.ps1 for the release
// archives, using the SAME generator `enconvert completion <shell>` uses at
// runtime — the shipped files and the printed scripts can never drift.
//
//   npm run gen:completions
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerCommands } from "../src/commands/index.js";
import { buildProgram } from "../src/program.js";
import {
  buildCompletionTree,
  COMPLETION_FILENAMES,
  generateCompletionScript,
  SUPPORTED_SHELLS,
} from "../src/util/completions.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "completions");
mkdirSync(outDir, { recursive: true });

const program = buildProgram();
registerCommands(program);
const tree = buildCompletionTree(program);

for (const shell of SUPPORTED_SHELLS) {
  const outPath = join(outDir, COMPLETION_FILENAMES[shell]);
  writeFileSync(outPath, generateCompletionScript(shell, tree));
  process.stdout.write(`${outPath}\n`);
}
