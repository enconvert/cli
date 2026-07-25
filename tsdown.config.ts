import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { enconvert: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  outExtensions: () => ({ js: ".js" }),
  clean: true,
  dts: false,
  minify: false,
  // dependencies is intentionally empty — every import is a devDependency and
  // gets bundled, producing a single self-contained ESM file with zero runtime deps.
});
