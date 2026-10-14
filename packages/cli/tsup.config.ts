import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineConfig, type Options } from "tsup";

type Plugin = NonNullable<Options["esbuildPlugins"]>[number];

/** `import text from "./x.html?raw"` → the file's contents as a string (same as Vite/vitest). */
const rawText: Plugin = {
  name: "raw-text",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      // Keep the "?raw" suffix so tsup's own `.css` loader doesn't claim the file.
      path: `${resolve(dirname(args.importer), args.path.replace(/\?raw$/, ""))}?raw`,
      namespace: "raw-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({
      contents: await readFile(args.path.replace(/\?raw$/, ""), "utf8"),
      loader: "text",
    }));
  },
};

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  // The wire contract is a workspace package; ship it inside dist so the tarball works standalone.
  noExternal: ["@agnt0/protocol"],
  // The preview page (HTML/CSS/JS) is inlined into dist so `agnt0 preview` needs no network or extra files.
  esbuildPlugins: [rawText],
  banner: { js: "#!/usr/bin/env node" },
});
