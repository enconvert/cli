// Input expansion. POSIX shells expand globs before we see them; Windows
// cmd/PowerShell do not — expand manually when an argument contains glob magic.
import { globSync } from "node:fs";
import { inputNotFoundError } from "../api/errors.js";

const GLOB_MAGIC = /[*?[\]{}]/;

export function expandInputs(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (GLOB_MAGIC.test(arg)) {
      const matches = globSync(arg).sort();
      if (matches.length === 0) {
        throw inputNotFoundError(`no files match "${arg}"`);
      }
      out.push(...matches);
    } else {
      out.push(arg);
    }
  }
  return out;
}
