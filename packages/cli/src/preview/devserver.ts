import { execa, type ResultPromise } from "execa";
import { createInterface } from "node:readline";
import { CliError } from "../errors.js";
import { freePort, httpUp, waitForHttp } from "../net.js";
import { detectDevServer, type DevServerPlan } from "./detect.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(?:\/[^\s'"]*)?/;
const EXPO_URL = /\bexps?:\/\/[^\s'"]+/;

/** The first local URL a dev server prints ("Local: http://localhost:5173/"), normalised to localhost. */
export function parseLocalUrl(line: string): string | null {
  const m = LOCAL_URL.exec(line.replace(ANSI, ""));
  if (!m) return null;
  const u = new URL(m[0].replace(/0\.0\.0\.0|\[::1?\]/, "localhost"));
  return `${u.protocol}//${u.hostname === "127.0.0.1" ? "127.0.0.1" : "localhost"}:${u.port}`;
}

export function parseExpoUrl(line: string): string | null {
  return EXPO_URL.exec(line.replace(ANSI, ""))?.[0] ?? null;
}

export interface DevServer {
  plan: DevServerPlan;
  pid: number | undefined;
  /** Resolves with the app's URL once it answers HTTP; rejects if the server exits or times out. */
  ready: Promise<string>;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
  expoUrl(): string | null;
  tail(n?: number): string[];
  onLine(fn: (line: string) => void): void;
  stop(): Promise<void>;
}

export interface StartDevServerOptions {
  root: string;
  env?: Record<string, string>;
  port?: number;
  timeoutMs?: number;
  plan?: DevServerPlan;
}

/** Kills the whole process group (npm → node → next…), escalating to SIGKILL. */
async function killTree(sub: ResultPromise, pid: number | undefined): Promise<void> {
  if (!pid || sub.exitCode !== null) return;
  if (process.platform === "win32") {
    await execa("taskkill", ["/pid", String(pid), "/T", "/F"], { reject: false });
    return;
  }
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };
  send("SIGTERM");
  const done = await Promise.race([sub.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
  if (!done) send("SIGKILL");
}

export async function startDevServer(opts: StartDevServerOptions): Promise<DevServer> {
  let plan = opts.plan;
  if (!plan) {
    const first = await detectDevServer(opts.root, opts.port);
    plan = opts.port ? first : await detectDevServer(opts.root, await freePort(first.port));
  }
  const lines: string[] = [];
  const listeners: Array<(l: string) => void> = [];
  let expo: string | null = null;
  let seenUrl: string | null = null;

  const sub = execa(plan.file, plan.args, {
    cwd: opts.root,
    env: { ...(opts.env ?? {}), ...plan.env, FORCE_COLOR: "0" },
    reject: false,
    buffer: false,
    stdin: "ignore",
    detached: process.platform !== "win32",
    cleanup: true,
  });
  const pid = sub.pid;
  // Detached children aren't cleaned up by execa; make sure the group dies with us.
  const onExit = () => {
    if (pid && sub.exitCode === null) {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  };
  process.once("exit", onExit);

  const take = (raw: string) => {
    const line = raw.replace(ANSI, "");
    lines.push(line);
    if (lines.length > 400) lines.shift();
    seenUrl ??= parseLocalUrl(line);
    expo ??= parseExpoUrl(line);
    for (const fn of listeners) fn(line);
  };
  for (const stream of [sub.stdout, sub.stderr]) {
    if (stream) createInterface({ input: stream, crlfDelay: Infinity }).on("line", take);
  }

  let exitCode: number | null | undefined;
  const exited = sub.then(
    (r) => (exitCode = r.exitCode ?? null),
    () => (exitCode = null),
  );

  const ready = (async () => {
    const until = Date.now() + (opts.timeoutMs ?? 120_000);
    const fallback = `http://localhost:${plan.port}`;
    while (Date.now() < until) {
      if (exitCode !== undefined) {
        const tail = lines.slice(-15).join("\n");
        throw new CliError(`The ${plan.label} dev server exited (code ${exitCode ?? "?"}) before it was ready.${tail ? `\n${tail}` : ""}`, `It was started with: ${plan.file} ${plan.args.join(" ")}`);
      }
      const candidate = seenUrl ?? fallback;
      if (await httpUp(candidate, 1500)) return candidate;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new CliError(`The ${plan.label} dev server didn't answer within ${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s.`, "Start it yourself and pass --url http://localhost:<port>.");
  })();
  ready.catch(() => {});

  return {
    plan,
    pid,
    ready,
    exited,
    expoUrl: () => expo,
    tail: (n = 20) => lines.slice(-n),
    onLine: (fn) => listeners.push(fn),
    stop: async () => {
      process.off("exit", onExit);
      await killTree(sub, pid);
    },
  };
}

/** For `--url`: an already running server we don't own. */
export async function attachDevServer(url: string, timeoutMs = 10_000): Promise<string> {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}`;
  if (!(await waitForHttp(base, { timeoutMs }))) throw new CliError(`Nothing answered at ${base}.`, "Start your dev server first, or drop --url to let agnt0 start it.");
  return base;
}
