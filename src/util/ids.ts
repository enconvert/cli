// Client-supplied job ids are crash-recovery handles: always generate one and
// send it, so a proxy timeout is recoverable via GET /v1/convert/status/{id}.
import { randomUUID } from "node:crypto";

export function newJobId(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Id kinds `enconvert jobs wait` can poll.
 *   ing_...    -> GET /v2/ingest/{id}
 *   per_...    -> GET /v2/perceive/{id}
 *   batch_...  -> ambiguous: v2 perceive batch AND v1 url batch both use batch_
 *                 (poll v2 first, fall back to v1 on 404)
 *   dst_...    -> distill is synchronous; nothing to poll
 *   wat_...    -> /v2/watch is out of CLI scope
 *   bare id    -> GET /v1/convert/status/{id}
 */
export type IdKind = "v1-job" | "batch" | "ingest" | "perceive" | "distill" | "watch";

export function detectIdKind(id: string): IdKind {
  if (id.startsWith("ing_")) return "ingest";
  if (id.startsWith("per_")) return "perceive";
  if (id.startsWith("dst_")) return "distill";
  if (id.startsWith("wat_")) return "watch";
  if (id.startsWith("batch_")) return "batch";
  return "v1-job";
}
