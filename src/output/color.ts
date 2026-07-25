// Colour resolution, highest -> lowest:
//   --color/--no-color -> FORCE_COLOR -> NO_COLOR (present AND non-empty) ->
//   CLICOLOR_FORCE/CLICOLOR -> config `color` -> auto (stderr TTY && TERM!=dumb && !CI)
//
// Gate on process.stderr.isTTY (human output goes to stderr), Boolean()-coerced:
// isTTY is `undefined`, not `false`, when detached.
import pc from "picocolors";

export type ColorMode = "auto" | "always" | "never";

export function resolveColorEnabled(
  flag: ColorMode | undefined,
  configValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stderr,
): boolean {
  if (flag === "always") return true;
  if (flag === "never") return false;

  const forceColor = env["FORCE_COLOR"];
  if (forceColor !== undefined && forceColor !== "") {
    return forceColor !== "0";
  }
  const noColor = env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") {
    // NO_COLOR="" does NOT disable colour (spec: present and non-empty).
    return false;
  }
  const clicolorForce = env["CLICOLOR_FORCE"];
  if (clicolorForce !== undefined && clicolorForce !== "" && clicolorForce !== "0") {
    return true;
  }
  if (env["CLICOLOR"] === "0") return false;

  if (configValue === "always") return true;
  if (configValue === "never") return false;

  return Boolean(stream.isTTY) && env["TERM"] !== "dumb" && !env["CI"];
}

export type Colors = ReturnType<typeof pc.createColors>;

let current: Colors = pc.createColors(false);

export function setColorEnabled(enabled: boolean): void {
  current = pc.createColors(enabled);
}

/** The active colour palette. Disabled until program.ts resolves the mode. */
export function c(): Colors {
  return current;
}
