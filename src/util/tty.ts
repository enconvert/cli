// TTY helpers. isTTY is `undefined`, not `false`, when detached — always coerce.

export function stdoutIsTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function stderrIsTty(): boolean {
  return Boolean(process.stderr.isTTY);
}

export function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/** Interactive session: both stdin and stderr are TTYs, and we're not in CI. */
export function isInteractive(): boolean {
  return stdinIsTty() && stderrIsTty() && !process.env["CI"];
}
