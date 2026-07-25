// Presigned-URL downloads: stream to disk via .tmp + atomic rename, progress
// on stderr, or raw bytes to stdout for `-o -`.
//
// Presigned URLs are plain storage URLs — no X-API-Key header is sent.
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Context } from "../config/resolve.js";
import { startProgress } from "../output/progress.js";
import { debug } from "../output/streams.js";
import { ensureDir } from "../util/files.js";
import { formatBytes } from "./errors.js";
import { networkError, CliError, EXIT } from "./errors.js";

async function openDownload(ctx: Context, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(ctx.timeoutMs) });
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    throw networkError("download failed", { details: [cause.message], cause });
  }
  if (!response.ok || response.body === null) {
    throw new CliError(`download failed with HTTP ${response.status}`, {
      exitCode: EXIT.SERVER_FAILURE,
      details: ["presigned URLs expire after 15 minutes; re-run the command or `enconvert jobs get <id>` for a fresh URL"],
    });
  }
  return response;
}

export async function downloadToFile(
  ctx: Context,
  url: string,
  destPath: string,
  opts: { label?: string } = {},
): Promise<{ path: string; size: number }> {
  const response = await openDownload(ctx, url);
  const total = Number(response.headers.get("content-length") ?? 0);
  ensureDir(dirname(destPath) === "" ? "." : dirname(destPath));
  const tmp = `${destPath}.tmp-${process.pid}`;
  const progress = startProgress(opts.label ?? `downloading ${destPath}`, {
    noProgress: ctx.opts.noProgress,
    jsonMode: ctx.opts.json === true || ctx.opts.jsonl === true,
  });
  let received = 0;
  try {
    const counter = new TransformStreamCounter((n) => {
      received += n;
      if (total > 0) {
        progress.update(`${opts.label ?? destPath}: ${formatBytes(received)} / ${formatBytes(total)}`);
      }
    });
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      counter.transform,
      createWriteStream(tmp),
    );
    await rename(tmp, destPath);
    progress.stop();
    debug(`downloaded ${received} bytes -> ${destPath}`);
    return { path: destPath, size: received };
  } catch (e) {
    progress.fail();
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function downloadToStdout(ctx: Context, url: string): Promise<void> {
  const response = await openDownload(ctx, url);
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
    process.stdout,
  );
}

import { Transform } from "node:stream";

class TransformStreamCounter {
  readonly transform: Transform;
  constructor(onChunk: (n: number) => void) {
    this.transform = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        onChunk(chunk.length);
        cb(null, chunk);
      },
    });
  }
}
