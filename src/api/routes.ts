// Lookup helpers over the generated (from, to) -> endpoint table.
import { unsupportedError } from "./errors.js";
import { UPLOAD_ROUTES, type UploadRoute } from "./routes.generated.js";

/** Format-name aliases users type vs the canonical route vocabulary. */
const FORMAT_ALIASES: Record<string, string> = {
  jpg: "jpeg",
  yml: "yaml",
  markdown: "md",
  htm: "html",
  heif: "heic",
  tif: "tiff",
  excel: "xlsx",
  word: "docx",
  powerpoint: "pptx",
};

export function canonicalFormat(fmt: string): string {
  const f = fmt.toLowerCase().replace(/^\./, "");
  return FORMAT_ALIASES[f] ?? f;
}

/** Output format each route produces, canonicalized (md, pdf, png, ...). */
function routeTarget(route: UploadRoute): string {
  return canonicalFormat(route.to);
}

function acceptsExt(route: UploadRoute, ext: string): boolean {
  return route.from.includes(`.${ext}`);
}

/**
 * Resolve the endpoint for (input extension, target format).
 * Preference order: specific pair route > universal (anything-to-*) route.
 */
export function resolveRoute(inputExt: string, to: string): UploadRoute {
  const ext = canonicalFormat(inputExt);
  // Match against raw extension too (canonicalFormat collapses jpg->jpeg, but
  // route.from lists real file extensions like ".jpg").
  const rawExt = inputExt.toLowerCase().replace(/^\./, "");
  const target = canonicalFormat(to);
  const candidates = UPLOAD_ROUTES.filter(
    (r) => routeTarget(r) === target && (acceptsExt(r, rawExt) || acceptsExt(r, ext)),
  );
  if (candidates.length === 0) {
    const fromRoutes = UPLOAD_ROUTES.filter((r) => acceptsExt(r, rawExt) || acceptsExt(r, ext));
    const targets = [...new Set(fromRoutes.map(routeTarget))].sort();
    throw unsupportedError(`no conversion from .${rawExt} to ${target}`, {
      details:
        targets.length > 0
          ? [`.${rawExt} can convert to: ${targets.join(", ")}`]
          : [`no conversions accept .${rawExt} input`],
      help: ["run `enconvert formats` for the full matrix", "or `enconvert formats --from <ext>`"],
    });
  }
  const specific = candidates.find((r) => r.group !== "universal");
  return specific ?? candidates[0]!;
}

export function findRouteByName(name: string): UploadRoute | undefined {
  return UPLOAD_ROUTES.find((r) => r.name === name);
}

export function routesAccepting(inputExt: string): UploadRoute[] {
  const rawExt = inputExt.toLowerCase().replace(/^\./, "");
  return UPLOAD_ROUTES.filter((r) => acceptsExt(r, rawExt) || acceptsExt(r, canonicalFormat(rawExt)));
}

export function routesProducing(target: string): UploadRoute[] {
  const t = canonicalFormat(target);
  return UPLOAD_ROUTES.filter((r) => routeTarget(r) === t);
}
