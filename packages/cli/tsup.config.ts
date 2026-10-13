import { defineConfig } from "tsup";

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
  banner: { js: "#!/usr/bin/env node" },
});
