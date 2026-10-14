import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";

export type Framework = "next" | "vite" | "expo" | "npm";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const FRAMEWORK_LABELS: Record<Framework, string> = { next: "Next.js", vite: "Vite", expo: "Expo", npm: "npm dev script" };

export interface DevServerPlan {
  framework: Framework;
  label: string;
  pm: PackageManager;
  file: string;
  args: string[];
  /** Where the server listens when nothing says otherwise. */
  port: number;
  /** Extra env for the dev server (e.g. PORT for Next and generic scripts). */
  env: Record<string, string>;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function runScript(pm: PackageManager, script: string, extra: string[] = []): { file: string; args: string[] } {
  if (pm === "npm") return { file: "npm", args: ["run", script, ...(extra.length ? ["--", ...extra] : [])] };
  if (pm === "yarn") return { file: "yarn", args: [script, ...extra] };
  return { file: pm, args: ["run", script, ...(extra.length ? (pm === "pnpm" ? ["--", ...extra] : extra) : [])] };
}

function execBin(pm: PackageManager, bin: string, args: string[]): { file: string; args: string[] } {
  if (pm === "npm") return { file: "npx", args: ["--no-install", bin, ...args] };
  if (pm === "pnpm") return { file: "pnpm", args: ["exec", bin, ...args] };
  if (pm === "yarn") return { file: "yarn", args: [bin, ...args] };
  return { file: "bunx", args: [bin, ...args] };
}

export async function readPackageJson(root: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Picks how to start the app's dev server from package.json: Expo, Next.js, Vite, or a plain `dev`
 * script, run with the project's own package manager.
 */
export async function detectDevServer(root: string, port?: number): Promise<DevServerPlan> {
  const pkg = await readPackageJson(root);
  if (!pkg) throw new CliError(`There's no package.json in ${root}.`, "agnt0 preview works with Next.js, Vite, Expo or any app with an npm `dev` script. Already running one? Pass --url http://localhost:<port>.");
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(root);

  if (deps.expo) {
    const p = port ?? 8081;
    return { framework: "expo", label: FRAMEWORK_LABELS.expo, pm, ...execBin(pm, "expo", ["start", "--port", String(p)]), port: p, env: { BROWSER: "none" } };
  }
  if (deps.next) {
    const p = port ?? 3000;
    const cmd = scripts.dev ? runScript(pm, "dev") : execBin(pm, "next", ["dev", "-p", String(p)]);
    return { framework: "next", label: FRAMEWORK_LABELS.next, pm, ...cmd, port: p, env: { PORT: String(p) } };
  }
  if (deps.vite) {
    const p = port ?? 5173;
    // Only a plain `vite` script is safe to pass flags to; otherwise read the URL it prints.
    const plain = scripts.dev && /^vite(\s+(dev|serve))?\s*$/.test(scripts.dev.trim());
    const cmd = !scripts.dev ? execBin(pm, "vite", ["--port", String(p)]) : plain && port ? runScript(pm, "dev", ["--port", String(p)]) : runScript(pm, "dev");
    return { framework: "vite", label: FRAMEWORK_LABELS.vite, pm, ...cmd, port: p, env: { BROWSER: "none" } };
  }
  if (scripts.dev) {
    const p = port ?? 3000;
    return { framework: "npm", label: FRAMEWORK_LABELS.npm, pm, ...runScript(pm, "dev"), port: p, env: { PORT: String(p), BROWSER: "none" } };
  }
  throw new CliError("Couldn't find a way to start this app's dev server.", "Add a `dev` script to package.json, or start it yourself and pass --url http://localhost:<port>.");
}
