// Shared test harness: a real local mock gateway + a subprocess CLI runner.
// Tests spawn the BUILT CLI (dist/enconvert.js) against the mock, in a scratch
// HOME, so request-shape goldens and output invariants exercise the same code
// paths users run. Build first: npm run build (the npm test script depends on it).
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

export const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_BIN = join(CLI_ROOT, "dist", "enconvert.js");
export const TEST_KEY = "sk_" + "a".repeat(43);

export interface RecordedRequest {
  method: string;
  /** Path + query string, e.g. "/v1/whoami?x=1". */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** JSON.parse of body when content-type is application/json, else undefined. */
  json: unknown;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void;

export interface MockGateway {
  url: string;
  requests: RecordedRequest[];
  /** Route "<METHOD> <path>" (exact path, no query) -> handler. */
  route(methodAndPath: string, handler: Handler): void;
  /** Shorthand: respond with a JSON body. */
  json(methodAndPath: string, status: number, body: unknown, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

export async function startMockGateway(): Promise<MockGateway> {
  const routes = new Map<string, Handler>();
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? "/", "http://localhost");
      let json: unknown;
      if ((req.headers["content-type"] ?? "").includes("application/json") && body.length > 0) {
        try {
          json = JSON.parse(body.toString("utf8"));
        } catch {
          json = undefined;
        }
      }
      const recorded: RecordedRequest = {
        method: (req.method ?? "GET").toUpperCase(),
        url: req.url ?? "/",
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body,
        json,
      };
      requests.push(recorded);
      const handler = routes.get(`${recorded.method} ${u.pathname}`);
      if (handler !== undefined) {
        handler(recorded, res);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `mock: no route for ${recorded.method} ${u.pathname}` }));
      }
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    route(methodAndPath, handler) {
      routes.set(methodAndPath, handler);
    },
    json(methodAndPath, status, body, headers = {}) {
      routes.set(methodAndPath, (_req, res) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      });
    },
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Defaults to a fresh scratch dir per call. */
  home?: string;
  cwd?: string;
}

export function scratchDir(prefix = "enc-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Spawn the built CLI with a hermetic environment. */
export function runCli(args: string[], opts: RunOptions = {}): Promise<CliResult> {
  const home = opts.home ?? scratchDir();
  const env: Record<string, string | undefined> = {
    PATH: process.env["PATH"],
    HOME: home,
    USERPROFILE: home,
    ENCONVERT_CONFIG_DIR: join(home, "enconvert-config"),
    ENCONVERT_API_KEY: TEST_KEY,
    CI: "1", // suppress progress + update nag deterministically
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
    CLICOLOR: undefined,
    CLICOLOR_FORCE: undefined,
    TERM: "xterm-256color",
    ...opts.env,
  };
  // Drop undefined values (spawn treats them as the string "undefined" otherwise... it does not, but be safe).
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: cleanEnv,
      cwd: opts.cwd ?? home,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", rejectPromise);
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`CLI did not exit within 30s: enconvert ${args.join(" ")}`));
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export interface MultipartField {
  name: string;
  filename?: string;
  contentType?: string;
  value: Buffer;
}

/** Minimal multipart/form-data parser for request-shape assertions. */
export function parseMultipart(body: Buffer, contentType: string): MultipartField[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!match) throw new Error(`no boundary in content-type: ${contentType}`);
  const boundary = `--${match[1] ?? match[2]}`;
  const fields: MultipartField[] = [];
  const parts = body.toString("binary").split(boundary).slice(1, -1);
  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerBlock = trimmed.slice(0, headerEnd);
    const valueBinary = trimmed.slice(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/.exec(headerBlock);
    const fileMatch = /filename="([^"]*)"/.exec(headerBlock);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerBlock);
    fields.push({
      name: nameMatch?.[1] ?? "",
      ...(fileMatch?.[1] !== undefined ? { filename: fileMatch[1] } : {}),
      ...(typeMatch?.[1] !== undefined ? { contentType: typeMatch[1] } : {}),
      value: Buffer.from(valueBinary, "binary"),
    });
  }
  return fields;
}

export function field(fields: MultipartField[], name: string): MultipartField | undefined {
  return fields.find((f) => f.name === name);
}
