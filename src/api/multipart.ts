// Multipart upload helpers. Every v1 upload route takes:
//   file (required) + output_filename + direct_download + job_id
// direct_download is inert on upload routes (the gateway always polls), so we
// always send "false" and parse the JSON envelope.
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { statInput } from "../util/files.js";
import { formatBytes } from "./errors.js";
import { warn } from "../output/streams.js";

/** Largest plan tier accepts 150 MB; anything beyond that can never succeed. */
const MAX_PLAN_BYTES = 150 * 1024 * 1024;

export interface UploadFieldValues {
  [field: string]: string | undefined;
}

export async function buildUploadForm(
  filePath: string,
  fields: UploadFieldValues,
): Promise<{ form: FormData; size: number }> {
  const { size } = statInput(filePath);
  if (size === 0) {
    warn(`${filePath} is empty (0 bytes); the gateway will likely reject it`);
  }
  if (size > MAX_PLAN_BYTES) {
    warn(
      `${filePath} is ${formatBytes(size)}; the largest plan limit is ${formatBytes(MAX_PLAN_BYTES)} — the upload will likely be rejected with 413`,
    );
  }
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append("file", blob, basename(filePath));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, value);
  }
  return { form, size };
}
