import { createServer } from "node:net";
import { request } from "node:http";

/** True when nothing is listening on 127.0.0.1:port (and we may bind it). */
export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** First free port in [start, start + span). Falls back to an OS-assigned port. */
export async function freePort(start: number, span = 50): Promise<number> {
  for (let p = start; p < start + span; p++) if (await portFree(p)) return p;
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolves true once `url` answers any HTTP response (404 counts: the server is up). */
export function httpUp(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve(false);
    }
    const req = request({ hostname: u.hostname === "localhost" ? "127.0.0.1" : u.hostname, port: u.port || 80, path: u.pathname || "/", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => {
      // Some dev servers only listen on ::1 for "localhost".
      if (u.hostname === "localhost") {
        const r6 = request({ hostname: "::1", port: u.port || 80, path: u.pathname || "/", method: "GET", timeout: timeoutMs }, (res) => {
          res.resume();
          resolve(true);
        });
        r6.on("timeout", () => {
          r6.destroy();
          resolve(false);
        });
        r6.on("error", () => resolve(false));
        r6.end();
      } else resolve(false);
    });
    req.end();
  });
}

export async function waitForHttp(url: string, opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal }): Promise<boolean> {
  const until = Date.now() + opts.timeoutMs;
  while (Date.now() < until) {
    if (opts.signal?.aborted) return false;
    if (await httpUp(url)) return true;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 300));
  }
  return false;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
