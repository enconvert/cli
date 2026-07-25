// The error[EXXX] renderer. Every error answers what / why / what-next:
//
//   error[E006]: plan quota exhausted
//
//       10,000 conversions/month on the Pro plan; used 10,000.
//
//       help: upgrade at https://enconvert.com/pricing
//       docs: https://enconvert.com/docs/errors/E006
import { CliError } from "../api/errors.js";
import { c } from "./color.js";
import { errLine } from "./streams.js";

export function renderError(err: unknown, opts: { debug?: boolean } = {}): void {
  const pc = c();
  if (err instanceof CliError) {
    errLine(`${pc.red(pc.bold(`error[${err.id}]`))}: ${err.message}`);
    if (err.details.length > 0) {
      errLine("");
      for (const line of err.details) errLine(`    ${line}`);
    }
    if (err.helpLines.length > 0 || err.docs) {
      errLine("");
      err.helpLines.forEach((line, i) => {
        errLine(i === 0 ? `    ${pc.cyan("help")}: ${line}` : `          ${line}`);
      });
      if (err.docs) errLine(`    ${pc.cyan("docs")}: ${err.docs}`);
    }
    if (opts.debug && err.stack) {
      errLine("");
      errLine(pc.dim(err.stack));
      if (err.cause instanceof Error && err.cause.stack) {
        errLine(pc.dim(`caused by: ${err.cause.stack}`));
      }
    }
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  errLine(`${pc.red(pc.bold("error[E001]"))}: ${message}`);
  if (opts.debug && err instanceof Error && err.stack) {
    errLine("");
    errLine(pc.dim(err.stack));
  }
}
