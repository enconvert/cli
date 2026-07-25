// `enconvert completion <shell> [install]` — static completion scripts.
// Printing goes to stdout (the script IS the payload); `install` writes the
// script to the conventional per-user location and prints the written path on
// stdout plus any shell-rc line the user must add on stderr. rc files are
// NEVER mutated by this command.
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Argument, type Command } from "commander";
import { CliError } from "../api/errors.js";
import { info, out } from "../output/streams.js";
import { contextFor } from "../program.js";
import {
  buildCompletionTree,
  COMPLETION_FILENAMES,
  generateCompletionScript,
  SUPPORTED_SHELLS,
  type CompletionShell,
} from "../util/completions.js";
import { emitJson } from "./_shared.js";

interface InstallPlan {
  path: string;
  /** Human instructions: shell-rc lines the user must add, prerequisites. */
  notes: string[];
}

function absoluteEnvDir(name: string, fallback: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "" && isAbsolute(value)) return value;
  return fallback;
}

function isWritableDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function installPlanFor(shell: CompletionShell): InstallPlan {
  const home = homedir();
  switch (shell) {
    case "bash": {
      const dataHome = absoluteEnvDir("XDG_DATA_HOME", join(home, ".local", "share"));
      const path = join(dataHome, "bash-completion", "completions", "enconvert");
      return {
        path,
        notes: [
          "loads automatically if the bash-completion (v2) package is installed.",
          "without bash-completion, add this line to ~/.bashrc:",
          `  source "${path}"`,
        ],
      };
    }
    case "zsh": {
      // $fpath is a zsh-internal array; the exported FPATH (when present) is
      // its colon-joined mirror. Fall back to a user-owned directory rather
      // than writing anywhere that needs sudo.
      const fpathDirs = (process.env["FPATH"] ?? "")
        .split(":")
        .filter((d) => d !== "" && isAbsolute(d) && isWritableDir(d));
      const first = fpathDirs[0];
      if (first !== undefined) {
        return {
          path: join(first, "_enconvert"),
          notes: ["restart zsh, or run: autoload -U compinit && compinit"],
        };
      }
      const dir = join(home, ".zsh", "completions");
      return {
        path: join(dir, "_enconvert"),
        notes: [
          "add these lines to ~/.zshrc BEFORE compinit runs:",
          `  fpath=("${dir}" $fpath)`,
          "  autoload -U compinit && compinit",
        ],
      };
    }
    case "fish": {
      const configHome = absoluteEnvDir("XDG_CONFIG_HOME", join(home, ".config"));
      return {
        path: join(configHome, "fish", "completions", "enconvert.fish"),
        notes: ["fish loads completions from this directory automatically; restart the shell."],
      };
    }
    case "powershell": {
      const path = join(home, ".enconvert", "completions", "enconvert.ps1");
      return {
        path,
        notes: [
          "add this line to your PowerShell $PROFILE (find it with: echo $PROFILE):",
          `  . "${path}"`,
        ],
      };
    }
  }
}

function writeCompletionFile(path: string, script: string, shell: CompletionShell): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, script);
  } catch (e) {
    const help =
      shell === "bash"
        ? [
            "write it system-wide yourself instead (never done automatically):",
            "  enconvert completion bash | sudo tee /usr/local/etc/bash_completion.d/enconvert",
          ]
        : [`print the script and place it manually: enconvert completion ${shell}`];
    throw new CliError(`cannot write completion script to ${path}`, { help, cause: e });
  }
}

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Generate a shell completion script (bash, zsh, fish, powershell)")
    .addArgument(new Argument("<shell>", "target shell").choices([...SUPPORTED_SHELLS]))
    .addArgument(
      new Argument("[action]", 'pass "install" to write the script to the standard per-user location').choices([
        "install",
      ]),
    )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  enconvert completion zsh                  print the zsh script to stdout",
        "  enconvert completion zsh install          write it to a directory on $fpath",
        "  enconvert completion bash install         write to ~/.local/share/bash-completion/completions",
        '  source <(enconvert completion bash)       enable for the current bash session',
        "",
        "The scripts are fully static (no network calls). Regenerate after upgrading.",
        "This command never edits your shell rc files; it prints any line you must add.",
      ].join("\n"),
    )
    .action((shellArg: string, action: string | undefined, _opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const shell = shellArg as CompletionShell;
      let root: Command = cmd;
      while (root.parent !== null && root.parent !== undefined) root = root.parent;
      const script = generateCompletionScript(shell, buildCompletionTree(root));

      if (action !== "install") {
        process.stdout.write(script);
        return;
      }

      const plan = installPlanFor(shell);
      if (ctx.opts.dryRun === true) {
        info(`would write the ${shell} completion script (${COMPLETION_FILENAMES[shell]}) to ${plan.path}`);
        for (const note of plan.notes) info(note);
        return;
      }
      writeCompletionFile(plan.path, script, shell);
      if (!emitJson(ctx, { shell, path: plan.path, notes: plan.notes })) {
        out(plan.path);
        info(`wrote ${shell} completion script to ${plan.path}`);
        for (const note of plan.notes) info(note);
      }
    });
}
