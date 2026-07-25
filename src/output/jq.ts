// Bundled jq-subset evaluator for --jq. No external jq binary required.
//
// Supported (documented in `enconvert help formatting`):
//   .                    identity
//   .foo.bar             field access (optional with `?`: .foo?)
//   .foo[0]  .[2]        array index (negative allowed)
//   .foo[]   .[]         array/object-value iteration
//   |                    pipe
//   length  keys  first  last  flatten  type
//   select(.path == literal) / select(.path != literal)
//   join("sep")
//
// jq semantics: each stage maps a stream of values to a stream of values.
import { usageError } from "../api/errors.js";

type Stage = (values: unknown[]) => unknown[];

function accessPath(value: unknown, segments: PathSegment[]): unknown[] {
  let stream: unknown[] = [value];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const v of stream) {
      if (seg.kind === "field") {
        if (v === null || v === undefined) {
          if (seg.optional) continue;
          next.push(null);
        } else if (typeof v === "object" && !Array.isArray(v)) {
          next.push((v as Record<string, unknown>)[seg.name] ?? null);
        } else if (seg.optional) {
          continue;
        } else {
          throw usageError(`--jq: cannot index ${typeName(v)} with ".${seg.name}"`);
        }
      } else if (seg.kind === "index") {
        if (Array.isArray(v)) {
          const idx = seg.index < 0 ? v.length + seg.index : seg.index;
          next.push(v[idx] ?? null);
        } else {
          throw usageError(`--jq: cannot index ${typeName(v)} with [${seg.index}]`);
        }
      } else {
        // iterate
        if (Array.isArray(v)) next.push(...v);
        else if (v !== null && typeof v === "object") next.push(...Object.values(v));
        else throw usageError(`--jq: cannot iterate over ${typeName(v)}`);
      }
    }
    stream = next;
  }
  return stream;
}

type PathSegment =
  | { kind: "field"; name: string; optional: boolean }
  | { kind: "index"; index: number }
  | { kind: "iterate" };

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function parsePath(expr: string): PathSegment[] {
  // expr starts with "."
  const segments: PathSegment[] = [];
  let i = 1;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "[") {
      const close = expr.indexOf("]", i);
      if (close === -1) throw usageError(`--jq: unterminated "[" in "${expr}"`);
      const inner = expr.slice(i + 1, close).trim();
      if (inner === "") {
        segments.push({ kind: "iterate" });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ kind: "index", index: Number(inner) });
      } else if (/^"[^"]*"$/.test(inner)) {
        segments.push({ kind: "field", name: inner.slice(1, -1), optional: false });
      } else {
        throw usageError(`--jq: unsupported index "${inner}"`);
      }
      i = close + 1;
    } else if (ch === ".") {
      i += 1;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(expr.slice(i));
      if (!match) throw usageError(`--jq: cannot parse "${expr}" at position ${i}`);
      let name = match[0];
      i += name.length;
      let optional = false;
      if (expr[i] === "?") {
        optional = true;
        i += 1;
      }
      segments.push({ kind: "field", name, optional });
    }
  }
  return segments;
}

function parseLiteral(raw: string): unknown {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    throw usageError(`--jq: cannot parse literal ${t} (use JSON syntax, e.g. "text", 3, true)`);
  }
}

function compileStage(raw: string): Stage {
  const expr = raw.trim();
  if (expr === "" || expr === ".") return (vs) => vs;
  if (expr === "length") {
    return (vs) =>
      vs.map((v) => {
        if (v === null) return 0;
        if (Array.isArray(v) || typeof v === "string") return v.length;
        if (typeof v === "object") return Object.keys(v as object).length;
        throw usageError(`--jq: ${typeName(v)} has no length`);
      });
  }
  if (expr === "keys") {
    return (vs) =>
      vs.map((v) => {
        if (Array.isArray(v)) return v.map((_, idx) => idx);
        if (v !== null && typeof v === "object") return Object.keys(v as object).sort();
        throw usageError(`--jq: ${typeName(v)} has no keys`);
      });
  }
  if (expr === "first") return (vs) => vs.map((v) => (Array.isArray(v) ? (v[0] ?? null) : v));
  if (expr === "last") return (vs) => vs.map((v) => (Array.isArray(v) ? (v[v.length - 1] ?? null) : v));
  if (expr === "flatten") {
    return (vs) => vs.map((v) => (Array.isArray(v) ? v.flat(Infinity) : v));
  }
  if (expr === "type") return (vs) => vs.map((v) => typeName(v));

  const selectMatch = /^select\((\.[^\s=!]*)\s*(==|!=)\s*(.+)\)$/.exec(expr);
  if (selectMatch) {
    const segments = parsePath(selectMatch[1]!);
    const op = selectMatch[2]!;
    const literal = parseLiteral(selectMatch[3]!);
    return (vs) =>
      vs.filter((v) => {
        const results = accessPath(v, segments);
        const actual = results[0] ?? null;
        const equal = JSON.stringify(actual) === JSON.stringify(literal);
        return op === "==" ? equal : !equal;
      });
  }

  const joinMatch = /^join\("([^"]*)"\)$/.exec(expr);
  if (joinMatch) {
    const sep = joinMatch[1]!;
    return (vs) =>
      vs.map((v) => {
        if (!Array.isArray(v)) throw usageError(`--jq: join() expects an array, got ${typeName(v)}`);
        return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(sep);
      });
  }

  if (expr.startsWith(".")) {
    const segments = parsePath(expr);
    return (vs) => vs.flatMap((v) => accessPath(v, segments));
  }

  throw usageError(
    `--jq: unsupported expression "${expr}"`,
    { help: ["supported: .path, .[], [N], |, length, keys, first, last, flatten, type, select(.p == x), join(\",\")", "see `enconvert help formatting`"] },
  );
}

/** Evaluate a jq-subset expression against a value; returns the result stream. */
export function evaluateJq(expression: string, input: unknown): unknown[] {
  const stages = splitPipes(expression).map(compileStage);
  let stream: unknown[] = [input];
  for (const stage of stages) stream = stage(stream);
  return stream;
}

function splitPipes(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (const ch of expression) {
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === "(" || ch === "[") depth += 1;
      if (ch === ")" || ch === "]") depth -= 1;
      if (ch === "|" && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Format jq results the way `gh --jq` does: raw strings, JSON for the rest, one per line. */
export function formatJqResults(results: unknown[]): string {
  return results
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r, null, results.length === 1 ? 2 : 0)))
    .join("\n");
}
