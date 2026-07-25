// Minimal Go-template-flavoured --template renderer.
//
// Supported (documented in `enconvert help formatting`):
//   {{.field.path}}            value substitution (strings raw, others JSON)
//   {{.}}                      the current value
//   {{range .path}}...{{end}}  iterate an array; inside, {{.x}} refers to the item
//   \n and \t escapes in the template string
import { usageError } from "../api/errors.js";

function lookup(value: unknown, path: string): unknown {
  if (path === "." || path === "") return value;
  const parts = path.replace(/^\./, "").split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      return null;
    }
  }
  return current ?? null;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function renderPlaceholders(segment: string, scope: unknown): string {
  return segment.replace(/\{\{\s*(\.[^}\s]*|\.)\s*\}\}/g, (_m, path: string) =>
    stringify(lookup(scope, path)),
  );
}

export function renderTemplate(template: string, data: unknown): string {
  const source = template.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  let out = "";
  let rest = source;
  const rangeRe = /\{\{\s*range\s+(\.[^}\s]*)\s*\}\}([\s\S]*?)\{\{\s*end\s*\}\}/;
  for (;;) {
    const m = rangeRe.exec(rest);
    if (!m) break;
    out += renderPlaceholders(rest.slice(0, m.index), data);
    const arr = lookup(data, m[1]!);
    if (arr !== null && !Array.isArray(arr)) {
      throw usageError(`--template: range over non-array at ${m[1]!}`);
    }
    for (const item of (arr as unknown[]) ?? []) {
      out += renderPlaceholders(m[2]!, item);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  out += renderPlaceholders(rest, data);
  return out;
}
