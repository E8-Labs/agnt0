// Runs before `npm pack` / `npm publish`: make sure the bundle exists and the license files are current.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgDir, "..", "..");

if (!existsSync(join(pkgDir, "dist", "index.js"))) {
  console.error("dist/index.js is missing. Run `pnpm --filter agnt0 build` first.");
  process.exit(1);
}
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
  const src = join(repoRoot, file);
  if (existsSync(src)) copyFileSync(src, join(pkgDir, file));
}
