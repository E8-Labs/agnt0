import { ROLE_LABELS, type Checkpoint, type LimitReached, type RealtimeEvent, type Role, type Ticket, type UsageSnapshot } from "@agnt0/protocol";

export interface AgentTile {
  stepId: string;
  role: Role;
  ticketId: string | null;
  startedAt: string;
  lastEvent: string | null;
  file: string | null;
  events: number;
  status: "running" | "succeeded" | "failed";
  credits: number | null;
  /** Tokens the step reported, once it has finished. */
  tokens: number | null;
  endedAt: string | null;
}

/** `34200` → `34.2k`: a tile has room for the magnitude, not the digits. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface FeedItem {
  at: string;
  text: string;
  kind: string;
}

export interface WatchState {
  tiles: AgentTile[];
  approvals: Ticket[];
  tickets: Record<string, Ticket>;
  feed: FeedItem[];
  usage: UsageSnapshot | null;
  limit: LimitReached | null;
  cliState: "idle" | "running" | "paused" | null;
  connection: "connecting" | "open" | "closed";
  /** Rollback requested from the dashboard: shown as a banner with the command to run (never auto-run). */
  restore: { checkpoint: Checkpoint; requestedAt: string } | null;
}

export const initialWatchState: WatchState = {
  tiles: [],
  approvals: [],
  tickets: {},
  feed: [],
  usage: null,
  limit: null,
  cliState: null,
  connection: "connecting",
  restore: null,
};

const MAX_FEED = 50;
const MAX_TILES = 12;

/** Running tiles first; otherwise keep arrival order (stable sort). */
function runningFirst(tiles: AgentTile[]): AgentTile[] {
  return [...tiles].sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
}

function pushFeed(feed: FeedItem[], item: FeedItem): FeedItem[] {
  return [item, ...feed].slice(0, MAX_FEED);
}

/** Pure reducer for realtime events, so the TUI is easy to test. */
export function reduceWatch(state: WatchState, ev: RealtimeEvent): WatchState {
  switch (ev.type) {
    case "step.started": {
      const tile: AgentTile = {
        stepId: ev.step_id,
        role: ev.role,
        ticketId: ev.ticket_id,
        startedAt: ev.at,
        lastEvent: null,
        file: null,
        events: 0,
        status: "running",
        credits: null,
        tokens: null,
        endedAt: null,
      };
      const tiles = runningFirst([tile, ...state.tiles.filter((t) => t.stepId !== ev.step_id)]);
      return { ...state, tiles: tiles.slice(0, MAX_TILES), feed: pushFeed(state.feed, { at: ev.at, kind: "start", text: `${ROLE_LABELS[ev.role]} started ${ev.ticket_id ?? ""}`.trim() }) };
    }
    case "step.event": {
      const tiles = state.tiles.map((t) =>
        t.stepId === ev.step_id
          ? { ...t, lastEvent: ev.event.summary, events: t.events + 1, file: ev.event.type === "file_diff" ? String(ev.event.data?.file ?? ev.event.summary) : t.file }
          : t,
      );
      return { ...state, tiles, feed: pushFeed(state.feed, { at: ev.event.at, kind: ev.event.type, text: ev.event.summary.split("\n")[0] ?? "" }) };
    }
    case "step.completed": {
      const ok = ev.outcome === "succeeded";
      const tiles = runningFirst(state.tiles.map((t) => (t.stepId === ev.step_id ? { ...t, status: ok ? ("succeeded" as const) : ("failed" as const), credits: ev.credits_charged, tokens: ev.tokens ?? null, endedAt: ev.at } : t)));
      const spent = `${ev.credits_charged} credits${ev.tokens ? ` · ${compactTokens(ev.tokens)} tokens` : ""}`;
      return { ...state, tiles, feed: pushFeed(state.feed, { at: ev.at, kind: ok ? "done" : "fail", text: `step ${ev.outcome} · ${spent}` }) };
    }
    case "ticket.updated": {
      const tickets = { ...state.tickets, [ev.ticket.id]: ev.ticket };
      const approvals = Object.values(tickets).filter((t) => t.status === "approval");
      return { ...state, tickets, approvals };
    }
    case "usage.updated":
      return { ...state, usage: ev.usage, limit: state.limit && ev.usage.session.used < ev.usage.session.allowance ? null : state.limit };
    case "limit.reached":
      return { ...state, limit: ev.limit, feed: pushFeed(state.feed, { at: new Date().toISOString(), kind: "limit", text: ev.limit.message }) };
    case "cli.heartbeat":
      return { ...state, cliState: ev.state };
    case "onboarding.updated":
      return state;
    case "checkpoint.restore_requested":
      return {
        ...state,
        restore: { checkpoint: ev.checkpoint, requestedAt: ev.requested_at },
        feed: pushFeed(state.feed, { at: ev.requested_at, kind: "restore", text: `rollback requested: run agnt0 rollback ${ev.checkpoint.id}` }),
      };
    case "checkpoint.created":
      return { ...state, feed: pushFeed(state.feed, { at: ev.checkpoint.created_at, kind: "checkpoint", text: `checkpoint ${ev.checkpoint.name}` }) };
    default:
      // Newer event types (notifications, checkpoints, preview, QA, audit) are shown in the feed generically.
      return { ...state, feed: pushFeed(state.feed, { at: new Date().toISOString(), kind: "event", text: ev.type.replace(".", " ") }) };
  }
}
