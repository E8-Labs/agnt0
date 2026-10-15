import { ROLE_LABELS, type RealtimeEvent, type UsageSnapshot } from "@agnt0/protocol";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useReducer, useState } from "react";
import { compactTokens, initialWatchState, reduceWatch, type AgentTile, type WatchState } from "./state.js";

type Action = { kind: "event"; event: RealtimeEvent } | { kind: "connection"; value: WatchState["connection"] } | { kind: "usage"; usage: UsageSnapshot };

function reducer(s: WatchState, a: Action): WatchState {
  if (a.kind === "event") return reduceWatch(s, a.event);
  if (a.kind === "connection") return { ...s, connection: a.value };
  return { ...s, usage: a.usage };
}

export interface WatchSource {
  subscribe(handlers: { onEvent: (e: RealtimeEvent) => void; onStatus: (s: WatchState["connection"]) => void }): () => void;
  loadUsage(): Promise<UsageSnapshot | null>;
}

function elapsed(fromIso: string, toIso: string | null, now: number): string {
  const ms = (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function bar(used: number, allowance: number, width = 16): string {
  const r = allowance > 0 ? Math.min(1, used / allowance) : 0;
  const f = Math.round(r * width);
  return "█".repeat(f) + "░".repeat(width - f);
}

function Tile({ t, now, width }: { t: AgentTile; now: number; width: number }) {
  const color = t.status === "running" ? "cyan" : t.status === "succeeded" ? "green" : "red";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} width={width} paddingX={1} marginRight={1}>
      <Text bold color={color} wrap="truncate">
        {ROLE_LABELS[t.role]}
      </Text>
      <Text dimColor wrap="truncate">
        {t.ticketId ?? "project"} · {t.stepId}
      </Text>
      <Text wrap="truncate">{t.file ? `✎ ${t.file}` : t.lastEvent ?? "starting…"}</Text>
      <Text dimColor wrap="truncate">
        {elapsed(t.startedAt, t.endedAt, now)} · {t.events} events{t.credits !== null ? ` · ${t.credits} cr` : ""}
        {t.tokens !== null ? ` · ${compactTokens(t.tokens)} tok` : ""}
        {/* Only on a step that actually read compressed tool output; silence means it read none. */}
        {t.tokensSaved ? ` · −${compactTokens(t.tokensSaved)} saved` : ""}
      </Text>
    </Box>
  );
}

export default function WatchApp({ projectLabel, source }: { projectLabel: string; source: WatchSource }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reducer, initialWatchState);
  const [now, setNow] = useState(Date.now());

  useInput((input) => {
    if (input === "q") exit();
  });

  useEffect(() => {
    const unsub = source.subscribe({
      onEvent: (event) => dispatch({ kind: "event", event }),
      onStatus: (value) => dispatch({ kind: "connection", value }),
    });
    void source.loadUsage().then((u) => u && dispatch({ kind: "usage", usage: u }));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [source]);

  const cols = stdout?.columns ?? 100;
  const tileWidth = Math.max(28, Math.min(40, Math.floor((cols - 2) / Math.max(1, Math.floor(cols / 36)))) - 1);
  const u = state.usage;
  const connColor = state.connection === "open" ? "green" : state.connection === "connecting" ? "yellow" : "red";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>agnt0 watch</Text> <Text dimColor>· {projectLabel}</Text>
        </Text>
        <Text>
          <Text color={connColor}>● {state.connection}</Text>
          {state.cliState ? <Text dimColor> · cli {state.cliState}</Text> : null}
          <Text dimColor> · q to quit</Text>
        </Text>
      </Box>

      {state.limit ? (
        <Box borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text color="yellow">
            ⏸ Paused: {state.limit.limit} limit reached · resets {new Date(state.limit.resets_at).toLocaleTimeString()} · agnt0 credits use / agnt0 upgrade
          </Text>
        </Box>
      ) : null}

      {state.restore ? (
        <Box borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text color="cyan">
            ↺ Rollback requested: {state.restore.checkpoint.name} · run <Text bold>agnt0 rollback {state.restore.checkpoint.id}</Text> in another terminal
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexWrap="wrap">
        {state.tiles.length === 0 ? <Text dimColor>No agents running yet. Start one with `agnt0 run`.</Text> : state.tiles.map((t) => <Tile key={t.stepId} t={t} now={now} width={tileWidth} />)}
      </Box>

      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" width="40%" marginRight={2}>
          <Text bold>Approvals waiting ({state.approvals.length})</Text>
          {state.approvals.length === 0 ? <Text dimColor>none</Text> : state.approvals.slice(0, 6).map((t) => <Text key={t.id} wrap="truncate">• {t.title}</Text>)}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>Live events</Text>
          {state.feed.length === 0 ? <Text dimColor>waiting for events…</Text> : null}
          {state.feed.slice(0, 10).map((f, i) => (
            <Text key={`${f.at}-${i}`} wrap="truncate">
              <Text dimColor>{new Date(f.at).toLocaleTimeString()} </Text>
              <Text color={f.kind === "fail" || f.kind === "limit" ? "red" : f.kind === "done" ? "green" : undefined}>{f.text}</Text>
            </Text>
          ))}
        </Box>
      </Box>

      <Box marginTop={1}>
        {u ? (
          <Text>
            <Text dimColor>session </Text>
            {bar(u.session.used, u.session.allowance)} {u.session.used}/{u.session.allowance}
            <Text dimColor>   week </Text>
            {bar(u.week.used, u.week.allowance)} {u.week.used}/{u.week.allowance}
            <Text dimColor>   extra </Text>
            {u.wallet.balance}
            {state.savedTokens > 0 ? (
              <Text>
                <Text dimColor>   saved </Text>
                <Text color="green">{compactTokens(state.savedTokens)} tok</Text>
                <Text dimColor> of tool output</Text>
              </Text>
            ) : null}
          </Text>
        ) : (
          <Text dimColor>loading usage…</Text>
        )}
      </Box>
    </Box>
  );
}
