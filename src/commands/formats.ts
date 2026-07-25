// `formats` (the conversion matrix) and `params convert` (per-route parameter
// reference). Both are fully offline — everything comes from the generated
// route table, so they work without an API key and never touch the network.
import type { Command } from "commander";
import { unsupportedError } from "../api/errors.js";
import { UPLOAD_ROUTES, type UploadRoute } from "../api/routes.generated.js";
import { resolveRoute, routesAccepting, routesProducing } from "../api/routes.js";
import { out } from "../output/streams.js";
import { renderTable } from "../output/table.js";
import { contextFor } from "../program.js";
import { emitJson } from "./_shared.js";

const GROUP_ORDER: Array<{ key: UploadRoute["group"]; label: string }> = [
  { key: "data", label: "data" },
  { key: "weasyprint", label: "documents (WeasyPrint)" },
  { key: "libreoffice", label: "office (LibreOffice)" },
  { key: "universal", label: "universal" },
  { key: "image", label: "images" },
  { key: "compression", label: "compression" },
];

/** Keep wide extension lists (anything-to-*) from blowing up the table width. */
function fromColumn(route: UploadRoute): string {
  const exts = route.from.map((e) => e.replace(/^\./, ""));
  if (exts.length <= 6) return exts.join(",");
  return `${exts.slice(0, 6).join(",")} +${exts.length - 6} more`;
}

function notesFor(route: UploadRoute): string {
  const notes: string[] = [];
  if (route.pdfOptions === "full") notes.push("pdf options");
  if (route.pdfOptions === "grayscale-only") notes.push("grayscale only");
  if (route.widthHeight) notes.push("width/height");
  if (route.targetSizeKb) notes.push("target-size-kb");
  return notes.join(", ");
}

export function registerFormatsCommands(program: Command): void {
  program
    .command("formats")
    .description("list every supported file conversion (offline; no API key needed)")
    .option("--from <fmt>", "only conversions accepting this input format")
    .option("--to <fmt>", "only conversions producing this format")
    .addHelpText(
      "after",
      "\nExamples:\n  enconvert formats\n  enconvert formats --from heic\n  enconvert formats --to pdf --json",
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const opts = cmd.opts<{ from?: string; to?: string }>();
      let routes: UploadRoute[] = [...UPLOAD_ROUTES];
      if (opts.from !== undefined) {
        const accepting = new Set(routesAccepting(opts.from).map((r) => r.name));
        routes = routes.filter((r) => accepting.has(r.name));
      }
      if (opts.to !== undefined) {
        const producing = new Set(routesProducing(opts.to).map((r) => r.name));
        routes = routes.filter((r) => producing.has(r.name));
      }
      if (routes.length === 0) {
        const filters: string[] = [];
        if (opts.from !== undefined) filters.push(`--from ${opts.from}`);
        if (opts.to !== undefined) filters.push(`--to ${opts.to}`);
        throw unsupportedError(`no conversions match ${filters.join(" ")}`, {
          help: ["run `enconvert formats` for the full matrix"],
        });
      }
      if (emitJson(ctx, routes)) return;

      const sections: string[] = [];
      for (const group of GROUP_ORDER) {
        const rows = routes
          .filter((r) => r.group === group.key)
          .map((r) => [fromColumn(r), r.to, r.name, notesFor(r)]);
        if (rows.length === 0) continue;
        sections.push(`${group.label}:\n${renderTable(rows, { header: ["from", "to", "endpoint", "notes"] })}`);
      }
      out(sections.join("\n\n"));
    });

  const params = program.command("params").description("show accepted parameters for a conversion");
  params
    .command("convert")
    .description("parameters for one (from, to) conversion pair (offline)")
    .requiredOption("--from <fmt>", "input format")
    .requiredOption("--to <fmt>", "target format")
    .addHelpText(
      "after",
      "\nExamples:\n  enconvert params convert --from svg --to png\n  enconvert params convert --from docx --to pdf --json",
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = contextFor(cmd);
      const opts = cmd.opts<{ from: string; to: string }>();
      const route = resolveRoute(opts.from, opts.to);
      if (emitJson(ctx, route)) return;

      out(`endpoint:  ${route.name} (POST ${route.endpoint})`);
      out(`accepts:   ${route.from.join(" ")}`);
      out(`produces:  ${route.to === "same-as-input" ? "same format as the input" : route.to}`);
      out("fields:    file (required), output_filename, job_id");
      if (route.pdfOptions === "full") {
        out(
          "pdf_options: full geometry — --pdf-page-size, --pdf-orientation, --pdf-margin, --pdf-scale, --pdf-grayscale, --pdf-header/--pdf-footer (+heights), --pdf-page-width/--pdf-page-height",
        );
      } else if (route.pdfOptions === "grayscale-only") {
        out("pdf_options: --pdf-grayscale only (LibreOffice-backed; geometry flags are rejected with 400)");
      }
      if (route.widthHeight) {
        out("width/height: --width/--height in px (each 1-10000; combined area <= 25,000,000 px)");
      }
      if (route.targetSizeKb) {
        out("target_size_kb: --target-size-kb <n> (>= 1)");
      }
      if (route.note !== undefined) {
        out(`note:      ${route.note}`);
      }
    });
}
