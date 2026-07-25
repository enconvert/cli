// Plain-text column alignment. No box-drawing, no wrapping libraries.
// Deliberately colour-free: tables are frequently the stdout PAYLOAD (formats,
// ingest list, lookup results) and stdout must never carry ANSI escapes.

export interface TableOptions {
  header?: string[];
  /** Right-align these column indices (numbers). */
  rightAlign?: number[];
}

export function renderTable(rows: string[][], opts: TableOptions = {}): string {
  const all = opts.header ? [opts.header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const lines: string[] = [];
  for (const row of all) {
    const rendered = row
      .map((cell, i) => {
        const w = widths[i] ?? 0;
        const isLast = i === row.length - 1;
        return opts.rightAlign?.includes(i) ? cell.padStart(w) : isLast ? cell : cell.padEnd(w);
      })
      .join("  ")
      .trimEnd();
    lines.push(rendered);
  }
  return lines.join("\n");
}
