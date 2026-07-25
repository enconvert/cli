// --json / --jsonl output. Exactly one parseable document on stdout for --json,
// byte-identical piped or on a TTY, zero ANSI. --jsonl is compact, newline-
// terminated, flushed per record.

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function printJsonl(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
