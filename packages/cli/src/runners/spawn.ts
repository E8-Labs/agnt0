import { execa } from "execa";
import { createInterface } from "node:readline";

export interface LineProcessResult {
  exitCode: number | null;
  stderr: string;
  aborted: boolean;
  spawnError?: string;
}

/**
 * Runs a command, feeding `input` on stdin (so step prompts never show up in `ps`), and calls `onLine`
 * for every stdout line as it arrives.
 */
export async function runLines(
  file: string,
  args: string[],
  opts: { cwd: string; input: string; signal: AbortSignal; onLine: (line: string) => void; env?: NodeJS.ProcessEnv },
): Promise<LineProcessResult> {
  const sub = execa(file, args, {
    cwd: opts.cwd,
    input: opts.input,
    cancelSignal: opts.signal,
    forceKillAfterDelay: 5000,
    reject: false,
    buffer: { stdout: false, stderr: true },
    env: opts.env,
    stripFinalNewline: true,
  });
  const done = new Promise<void>((resolve) => {
    if (!sub.stdout) return resolve();
    const rl = createInterface({ input: sub.stdout, crlfDelay: Infinity });
    rl.on("line", (l) => {
      try {
        opts.onLine(l);
      } catch {
        /* a bad line must not kill the run */
      }
    });
    rl.on("close", () => resolve());
  });
  const r = await sub;
  await done;
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  const spawnError = r.failed && r.exitCode === undefined && !r.isCanceled ? (r.shortMessage ?? "failed to start") : undefined;
  return { exitCode: r.exitCode ?? null, stderr, aborted: Boolean(r.isCanceled) || opts.signal.aborted, spawnError };
}

/**
 * Runs a command and returns its output. For asking a runner about itself (a model catalog, a
 * policy check) rather than driving a step. `maxBuffer` is generous: Codex's catalog is ~650KB.
 */
export async function runCapture(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const r = await execa(file, args, {
    reject: false,
    timeout: opts.timeoutMs ?? 20_000,
    maxBuffer: 32 * 1024 * 1024,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  return { exitCode: r.exitCode ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export async function commandVersion(file: string, args = ["--version"], timeout = 10000): Promise<string | null> {
  try {
    const r = await execa(file, args, { reject: false, timeout });
    if (r.exitCode !== 0) return null;
    return (r.stdout || r.stderr).trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}
