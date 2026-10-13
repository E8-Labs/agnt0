import { RealtimeEvent, routes, UsageSnapshot } from "@agnt0/protocol";
import WebSocket from "ws";
import type { ApiClient, TokenProvider } from "../api/client.js";
import { debug } from "../config.js";
import type { WatchSource } from "./App.js";

export function realtimeUrl(apiUrl: string, projectId: string, token: string): string {
  const u = new URL(apiUrl + routes.realtime(projectId));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.toString();
}

/** WebSocket source with reconnect + token refresh. */
export function createWatchSource(opts: { api: ApiClient; apiUrl: string; projectId: string; tokens: TokenProvider }): WatchSource {
  return {
    loadUsage: async () => {
      try {
        return await opts.api.get(routes.usage, { schema: UsageSnapshot });
      } catch (e) {
        debug("usage load failed", e);
        return null;
      }
    },
    subscribe: ({ onEvent, onStatus }) => {
      let ws: WebSocket | null = null;
      let stopped = false;
      let attempt = 0;
      let timer: NodeJS.Timeout | null = null;

      const connect = async (refresh: boolean) => {
        if (stopped) return;
        onStatus("connecting");
        const token = refresh ? await opts.tokens.refresh() : await opts.tokens.getAccessToken();
        if (!token || stopped) {
          onStatus("closed");
          return;
        }
        ws = new WebSocket(realtimeUrl(opts.apiUrl, opts.projectId, token));
        ws.on("open", () => {
          attempt = 0;
          onStatus("open");
        });
        ws.on("message", (data) => {
          try {
            const parsed = RealtimeEvent.safeParse(JSON.parse(data.toString()));
            if (parsed.success) onEvent(parsed.data);
          } catch (e) {
            debug("bad realtime message", e);
          }
        });
        ws.on("unexpected-response", (_req, res) => {
          debug("realtime rejected", res.statusCode);
          ws?.terminate();
          schedule(res.statusCode === 401);
        });
        ws.on("error", (e) => debug("realtime error", e));
        ws.on("close", (code) => {
          if (stopped) return;
          schedule(code === 4401);
        });
      };
      const schedule = (refresh: boolean) => {
        if (stopped || timer) return;
        onStatus("closed");
        attempt++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        timer = setTimeout(() => {
          timer = null;
          void connect(refresh);
        }, delay);
      };
      void connect(false);
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        ws?.removeAllListeners();
        ws?.on("error", () => {});
        ws?.close();
      };
    },
  };
}
