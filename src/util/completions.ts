// Static shell-completion generation: commander introspection in, script text out.
//
// Why not @bomb.sh/tab: its commander adapter registers its own `complete`
// command and emits scripts that call BACK into the CLI on every TAB press.
// That shape cannot express `completion <shell> [install]`, snapshots the
// command tree before all groups are registered, and pays a node startup per
// keystroke. Fully static scripts avoid all three — and satisfy the plan's
// HARD RULE: no network I/O on any completion path. Format values for
// --to/--from/--endpoint come statically from routes.generated.ts.
import type { Command } from "commander";
import { UPLOAD_ROUTES } from "../api/routes.generated.js";

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export const SUPPORTED_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish", "powershell"];

/** File names used both by `completion <shell> install` and the build script. */
export const COMPLETION_FILENAMES: Record<CompletionShell, string> = {
  bash: "enconvert.bash",
  zsh: "_enconvert",
  fish: "enconvert.fish",
  powershell: "_enconvert.ps1",
};

export interface CompletionFlag {
  long: string;
  short?: string;
  /** True when the flag takes a value argument. */
  takesValue: boolean;
  /** Static value suggestions for the flag's argument. */
  choices?: string[];
  description: string;
}

export interface CompletionNode {
  name: string;
  description: string;
  /**
   * The command's OWN flags only. The root program enables positional
   * options, so global flags are valid solely BEFORE the subcommand name —
   * suggesting them after a subcommand would offer flags commander rejects.
   */
  flags: CompletionFlag[];
  children: CompletionNode[];
  /** Positional-argument choice values (e.g. shell names, mcp client ids). */
  positionalChoices: string[];
}

// Format vocabularies, taken STATICALLY from the generated route table.
const TO_FORMATS = [...new Set(UPLOAD_ROUTES.map((r) => r.to).filter((t) => t !== "same-as-input"))].sort();
const FROM_FORMATS = [...new Set(UPLOAD_ROUTES.flatMap((r) => r.from.map((e) => e.replace(/^\./, ""))))].sort();
const ENDPOINT_NAMES = UPLOAD_ROUTES.map((r) => r.name).sort();

function choicesFor(long: string, argChoices: string[] | undefined): string[] | undefined {
  if (long === "--to") return TO_FORMATS;
  if (long === "--from") return FROM_FORMATS;
  if (long === "--endpoint") return ENDPOINT_NAMES;
  return argChoices;
}

function firstLine(text: string): string {
  const line = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return line.length > 78 ? `${line.slice(0, 75)}...` : line;
}

function isHiddenCommand(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

function flagsOf(cmd: Command): CompletionFlag[] {
  const flags: CompletionFlag[] = [];
  for (const opt of cmd.options) {
    if (opt.hidden || opt.long === undefined) continue;
    const choices = choicesFor(opt.long, opt.argChoices);
    flags.push({
      long: opt.long,
      ...(opt.short !== undefined ? { short: opt.short } : {}),
      takesValue: opt.required || opt.optional,
      ...(choices !== undefined ? { choices } : {}),
      description: firstLine(opt.description),
    });
  }
  // -h/--help is synthesized by commander and not present in cmd.options.
  if (!flags.some((f) => f.long === "--help")) {
    flags.push({ long: "--help", short: "-h", takesValue: false, description: "show help" });
  }
  return flags;
}

function positionalChoicesOf(cmd: Command): string[] {
  const set = new Set<string>();
  for (const arg of cmd.registeredArguments) {
    for (const choice of arg.argChoices ?? []) set.add(choice);
  }
  return [...set];
}

function buildNode(cmd: Command): CompletionNode {
  return {
    name: cmd.name(),
    description: firstLine(cmd.description()),
    flags: flagsOf(cmd),
    children: cmd.commands.filter((sub) => !isHiddenCommand(sub)).map((sub) => buildNode(sub)),
    positionalChoices: positionalChoicesOf(cmd),
  };
}

/** Introspect a fully-registered commander program into a completion tree. */
export function buildCompletionTree(program: Command): CompletionNode {
  return buildNode(program);
}

interface FlatNode {
  /** Space-joined subcommand path; "" for the root. */
  path: string;
  node: CompletionNode;
}

function flattenTree(root: CompletionNode): FlatNode[] {
  const flat: FlatNode[] = [];
  const walk = (node: CompletionNode, path: string): void => {
    flat.push({ path, node });
    for (const child of node.children) {
      walk(child, path === "" ? child.name : `${path} ${child.name}`);
    }
  };
  walk(root, "");
  return flat;
}

function flagTokens(flag: CompletionFlag): string[] {
  return flag.short !== undefined ? [flag.long, flag.short] : [flag.long];
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function generateBash(root: CompletionNode): string {
  const flat = flattenTree(root);
  const knownPatterns = flat
    .filter((f) => f.path !== "")
    .map((f) => `"${f.path}"`)
    .join("|");

  const valueCases: string[] = [];
  const nodeCases: string[] = [];
  for (const { path, node } of flat) {
    for (const flag of node.flags) {
      if (!flag.takesValue || flag.choices === undefined || flag.choices.length === 0) continue;
      const patterns = flagTokens(flag)
        .map((t) => `"${path}|${t}"`)
        .join("|");
      valueCases.push(
        `    ${patterns})`,
        `      COMPREPLY=( $(compgen -W "${flag.choices.join(" ")}" -- "$cur") )`,
        "      return ;;",
      );
    }
    const subs = [...node.children.map((c) => c.name), ...node.positionalChoices].join(" ");
    const flags = node.flags.flatMap(flagTokens).join(" ");
    nodeCases.push(`    "${path}")`, `      subs="${subs}"`, `      flags="${flags}"`, "      ;;");
  }

  return [
    "# bash completion for enconvert                            -*- shell-script -*-",
    "# Generated by `enconvert completion bash`. Fully static: no network calls,",
    "# no callbacks into the CLI. Regenerate after upgrading enconvert.",
    "",
    "_enconvert_known_path() {",
    "  case \"$1\" in",
    `    ${knownPatterns}) return 0 ;;`,
    "  esac",
    "  return 1",
    "}",
    "",
    "_enconvert() {",
    "  local cur prev",
    "  COMPREPLY=()",
    "  cur=\"\${COMP_WORDS[COMP_CWORD]}\"",
    "  prev=\"\${COMP_WORDS[COMP_CWORD-1]}\"",
    "",
    "  # Resolve the subcommand path, skipping flags (and, implicitly, flag",
    "  # values and positionals: only known subcommand names extend the path).",
    "  local path=\"\" candidate=\"\" w=\"\" i",
    "  for ((i = 1; i < COMP_CWORD; i++)); do",
    "    w=\"\${COMP_WORDS[i]}\"",
    "    case \"$w\" in -*) continue ;; esac",
    "    if [ -z \"$path\" ]; then candidate=\"$w\"; else candidate=\"$path $w\"; fi",
    "    if _enconvert_known_path \"$candidate\"; then path=\"$candidate\"; fi",
    "  done",
    "",
    "  # Value suggestions for the flag before the cursor.",
    "  case \"$path|$prev\" in",
    ...valueCases,
    "  esac",
    "",
    "  local subs=\"\" flags=\"\"",
    "  case \"$path\" in",
    ...nodeCases,
    "  esac",
    "",
    "  if [[ \"$cur\" == -* ]]; then",
    "    COMPREPLY=( $(compgen -W \"$flags\" -- \"$cur\") )",
    "  elif [ -n \"$subs\" ]; then",
    "    COMPREPLY=( $(compgen -W \"$subs\" -- \"$cur\") )",
    "  fi",
    "}",
    "",
    "complete -o default -o bashdefault -F _enconvert enconvert",
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

/** _describe items use name:description; strip characters that break the format. */
function zshDesc(text: string): string {
  return text.replace(/[:'\\]/g, " ").replace(/\s+/g, " ").trim();
}

function zshItem(name: string, description: string): string {
  const desc = zshDesc(description);
  return desc === "" ? `'${name}'` : `'${name}:${desc}'`;
}

function generateZsh(root: CompletionNode): string {
  const flat = flattenTree(root);
  const knownPatterns = flat
    .filter((f) => f.path !== "")
    .map((f) => `"${f.path}"`)
    .join("|");

  const valueCases: string[] = [];
  const nodeCases: string[] = [];
  for (const { path, node } of flat) {
    for (const flag of node.flags) {
      if (!flag.takesValue || flag.choices === undefined || flag.choices.length === 0) continue;
      const patterns = flagTokens(flag)
        .map((t) => `"${path}|${t}"`)
        .join("|");
      valueCases.push(
        `    ${patterns})`,
        `      vals=(${flag.choices.join(" ")})`,
        "      _describe -t values 'value' vals",
        "      return ;;",
      );
    }
    const subItems = [
      ...node.children.map((c) => zshItem(c.name, c.description)),
      ...node.positionalChoices.map((c) => zshItem(c, "")),
    ];
    const flagItems = node.flags.flatMap((f) => flagTokens(f).map((t) => zshItem(t, f.description)));
    nodeCases.push(
      `    "${path}")`,
      `      subs=(${subItems.join(" ")})`,
      `      flags=(${flagItems.join(" ")})`,
      "      ;;",
    );
  }

  return [
    "#compdef enconvert",
    "# zsh completion for enconvert.",
    "# Generated by `enconvert completion zsh`. Fully static: no network calls,",
    "# no callbacks into the CLI. Regenerate after upgrading enconvert.",
    "",
    "_enconvert_known_path() {",
    "  case \"$1\" in",
    `    ${knownPatterns}) return 0 ;;`,
    "  esac",
    "  return 1",
    "}",
    "",
    "_enconvert() {",
    "  local cur prev pathkey=\"\" candidate=\"\" w=\"\"",
    "  integer i",
    "  cur=\"\${words[CURRENT]}\"",
    "  prev=\"\"",
    "  (( CURRENT > 1 )) && prev=\"\${words[CURRENT-1]}\"",
    "",
    "  for (( i = 2; i < CURRENT; i++ )); do",
    "    w=\"\${words[i]}\"",
    "    [[ \"$w\" == -* ]] && continue",
    "    if [[ -z \"$pathkey\" ]]; then candidate=\"$w\"; else candidate=\"$pathkey $w\"; fi",
    "    if _enconvert_known_path \"$candidate\"; then pathkey=\"$candidate\"; fi",
    "  done",
    "",
    "  local -a vals",
    "  case \"$pathkey|$prev\" in",
    ...valueCases,
    "  esac",
    "",
    "  local -a subs flags",
    "  case \"$pathkey\" in",
    ...nodeCases,
    "  esac",
    "",
    "  if [[ \"$cur\" == -* ]]; then",
    "    _describe -t options 'option' flags",
    "  elif (( \${#subs[@]} )); then",
    "    _describe -t commands 'command' subs || _files",
    "  else",
    "    _files",
    "  fi",
    "}",
    "",
    "if [[ \"\${zsh_eval_context[-1]}\" == \"loadautofunc\" ]]; then",
    "  _enconvert \"$@\"",
    "else",
    "  compdef _enconvert enconvert",
    "fi",
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

function fishDesc(text: string): string {
  return text.replace(/['\\]/g, " ").replace(/\s+/g, " ").trim();
}

function generateFish(root: CompletionNode): string {
  const flat = flattenTree(root);
  const knownList = flat
    .filter((f) => f.path !== "")
    .map((f) => `'${f.path}'`)
    .join(" ");

  const lines: string[] = [
    "# fish completion for enconvert.",
    "# Generated by `enconvert completion fish`. Fully static: no network calls,",
    "# no callbacks into the CLI. Regenerate after upgrading enconvert.",
    "",
    "function __enconvert_known_path",
    `    contains -- $argv[1] ${knownList}`,
    "end",
    "",
    "function __enconvert_path",
    "    set -l tokens (commandline -opc)",
    "    set -e tokens[1]",
    "    set -l path ''",
    "    set -l candidate ''",
    "    for t in $tokens",
    "        if string match -q -- '-*' $t",
    "            continue",
    "        end",
    "        if test -z \"$path\"",
    "            set candidate $t",
    "        else",
    "            set candidate \"$path $t\"",
    "        end",
    "        if __enconvert_known_path $candidate",
    "            set path $candidate",
    "        end",
    "    end",
    "    echo $path",
    "end",
    "",
    "function __enconvert_at",
    "    test \"$(__enconvert_path)\" = \"$argv[1]\"",
    "end",
    "",
  ];

  for (const { path, node } of flat) {
    const cond = `__enconvert_at "${path}"`;
    if (node.children.length > 0 || node.positionalChoices.length > 0 || node.flags.length > 0) {
      lines.push(`# ${path === "" ? "enconvert" : `enconvert ${path}`}`);
    }
    for (const child of node.children) {
      const desc = fishDesc(child.description);
      lines.push(
        `complete -c enconvert -f -n '${cond}' -a ${child.name}${desc !== "" ? ` -d '${desc}'` : ""}`,
      );
    }
    if (node.positionalChoices.length > 0) {
      lines.push(`complete -c enconvert -f -n '${cond}' -a '${node.positionalChoices.join(" ")}'`);
    }
    for (const flag of node.flags) {
      const parts = [`complete -c enconvert -n '${cond}'`, `-l ${flag.long.replace(/^--/, "")}`];
      if (flag.short !== undefined) parts.push(`-s ${flag.short.replace(/^-/, "")}`);
      if (flag.takesValue && flag.choices !== undefined && flag.choices.length > 0) {
        parts.push("-x", `-a '${flag.choices.join(" ")}'`);
      } else if (flag.takesValue) {
        parts.push("-r");
      }
      const desc = fishDesc(flag.description);
      if (desc !== "") parts.push(`-d '${desc}'`);
      lines.push(parts.join(" "));
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// powershell
// ---------------------------------------------------------------------------

function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function generatePowershell(root: CompletionNode): string {
  const flat = flattenTree(root);

  const nodeEntries: string[] = [];
  for (const { path, node } of flat) {
    const subs = [
      ...node.children.map((c) => `@{ n = ${psQuote(c.name)}; d = ${psQuote(c.description)} }`),
      ...node.positionalChoices.map((c) => `@{ n = ${psQuote(c)}; d = '' }`),
    ];
    const flags = node.flags.map((f) => {
      const choices = f.takesValue && f.choices !== undefined ? f.choices : [];
      const values = choices.length > 0 ? `@(${choices.map(psQuote).join(", ")})` : "@()";
      return `@{ n = ${psQuote(f.long)}; s = ${psQuote(f.short ?? "")}; d = ${psQuote(f.description)}; v = ${values} }`;
    });
    nodeEntries.push(
      `        ${psQuote(path)} = @{`,
      `            subs = @(${subs.join(", ")})`,
      `            flags = @(${flags.join(", ")})`,
      "        }",
    );
  }

  return [
    "# PowerShell completion for enconvert.",
    "# Generated by `enconvert completion powershell`. Fully static: no network",
    "# calls, no callbacks into the CLI. Regenerate after upgrading enconvert.",
    "",
    "Register-ArgumentCompleter -Native -CommandName enconvert -ScriptBlock {",
    "    param($wordToComplete, $commandAst, $cursorPosition)",
    "",
    "    $nodes = @{",
    ...nodeEntries,
    "    }",
    "",
    "    $elements = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })",
    "    $word = \"$wordToComplete\"",
    "    $lastIndex = $elements.Count - 1",
    "",
    "    $path = ''",
    "    for ($i = 1; $i -le $lastIndex; $i++) {",
    "        $token = $elements[$i]",
    "        if ($i -eq $lastIndex -and $word -ne '' -and $token -eq $word) { break }",
    "        if ($token.StartsWith('-')) { continue }",
    "        $candidate = if ($path -eq '') { $token } else { \"$path $token\" }",
    "        if ($nodes.ContainsKey($candidate)) { $path = $candidate }",
    "    }",
    "    $node = $nodes[$path]",
    "",
    "    $prev = ''",
    "    if ($word -ne '' -and $lastIndex -ge 1 -and $elements[$lastIndex] -eq $word) {",
    "        if ($lastIndex -ge 2) { $prev = $elements[$lastIndex - 1] }",
    "    } elseif ($lastIndex -ge 1) {",
    "        $prev = $elements[$lastIndex]",
    "    }",
    "",
    "    $results = @()",
    "    if ($prev.StartsWith('-')) {",
    "        foreach ($f in $node.flags) {",
    "            if (($f.n -eq $prev -or ($f.s -ne '' -and $f.s -eq $prev)) -and $f.v.Count -gt 0) {",
    "                foreach ($v in $f.v) {",
    "                    if ($v -like \"$word*\") {",
    "                        $results += [System.Management.Automation.CompletionResult]::new($v, $v, 'ParameterValue', $v)",
    "                    }",
    "                }",
    "                return $results",
    "            }",
    "        }",
    "    }",
    "",
    "    if ($word.StartsWith('-')) {",
    "        foreach ($f in $node.flags) {",
    "            if ($f.n -like \"$word*\") {",
    "                $tip = if ($f.d) { $f.d } else { $f.n }",
    "                $results += [System.Management.Automation.CompletionResult]::new($f.n, $f.n, 'ParameterName', $tip)",
    "            }",
    "            if ($f.s -ne '' -and $f.s -like \"$word*\") {",
    "                $tip = if ($f.d) { $f.d } else { $f.s }",
    "                $results += [System.Management.Automation.CompletionResult]::new($f.s, $f.s, 'ParameterName', $tip)",
    "            }",
    "        }",
    "    } else {",
    "        foreach ($s in $node.subs) {",
    "            if ($s.n -like \"$word*\") {",
    "                $tip = if ($s.d) { $s.d } else { $s.n }",
    "                $results += [System.Management.Automation.CompletionResult]::new($s.n, $s.n, 'Command', $tip)",
    "            }",
    "        }",
    "    }",
    "    $results",
    "}",
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------

export function generateCompletionScript(shell: CompletionShell, root: CompletionNode): string {
  switch (shell) {
    case "bash":
      return generateBash(root);
    case "zsh":
      return generateZsh(root);
    case "fish":
      return generateFish(root);
    case "powershell":
      return generatePowershell(root);
  }
}
