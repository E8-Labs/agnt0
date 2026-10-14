import type { StepEvent, TokenUsage } from "@agnt0/protocol";
import { categorizeDenial } from "./tools.js";
import { zeroUsage } from "./types.js";

type Json = Record<string, unknown>;

interface UsageNums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

function usageOf(u: unknown): UsageNums | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Json;
  return {
    input: num(o.input_tokens),
    output: num(o.output_tokens),
    cacheRead: num(o.cache_read_input_tokens),
    cacheWrite: num(o.cache_creation_input_tokens),
  };
}

function short(v: unknown, max = 300): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function trimInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Json)) {
    out[k] = typeof v === "string" ? short(v, 500) : typeof v === "object" ? short(v, 500) : v;
  }
  return out;
}

/** Claude Code's wording when a tool call is blocked by permissions (deny rule or not allowed in -p). */
const DENIAL_TEXT = /permission to use .* (has been|was) denied|haven't granted it|requested permissions? to use|not allowed|denied by/i;

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const BROWSE_TOOLS = new Set(["WebFetch", "WebSearch"]);

export function toolUseToEvent(name: string, input: unknown, at: string): StepEvent {
  const i = (input ?? {}) as Json;
  if (FILE_TOOLS.has(name)) {
    const file = String(i.file_path ?? i.notebook_path ?? i.path ?? "");
    return { type: "file_diff", summary: short(`${name} ${file}`, 2000), at, data: { tool: name, file } };
  }
  if (BROWSE_TOOLS.has(name)) {
    const target = String(i.url ?? i.query ?? "");
    return { type: "browse", summary: short(`${name} ${target}`, 2000), at, data: { tool: name, target } };
  }
  let detail = "";
  if (name === "Bash") detail = String(i.command ?? "");
  else if (name === "Read") detail = String(i.file_path ?? "");
  else if (name === "Grep" || name === "Glob") detail = String(i.pattern ?? "");
  else detail = short(input, 200);
  return { type: "tool_call", summary: short(`${name} ${detail}`.trim(), 2000), at, data: { tool: name, input: trimInput(input) } };
}

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose`. Feed it one line at a time;
 * it emits StepEvents for assistant text and tool calls and tracks token usage.
 *
 * Usage: the final `result` message carries the session total. Per-turn usage on assistant messages is
 * summed too (deduplicated by message id, since one message is streamed as several lines) and used as a
 * floor, so a missing or partial `result` never under-reports.
 */
export class ClaudeStreamParser {
  model: string;
  private perMessage = new Map<string, UsageNums>();
  private resultUsage: UsageNums | null = null;
  resultText: string | null = null;
  isError = false;
  subtype: string | null = null;
  numTurns = 0;
  lastAssistantText = "";
  sessionId: string | null = null;
  /** tool_use id → call, so denials can be explained. */
  private toolCalls = new Map<string, { name: string; input: unknown }>();
  private deniedIds = new Set<string>();
  /** Approval categories the agent ran into (deduped, in order). */
  readonly approvalsNeeded: string[] = [];

  constructor(
    defaultModel: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.model = defaultModel;
  }

  /** Returns the events this line produced. Non-JSON lines are ignored. */
  push(line: string): StepEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    let msg: Json;
    try {
      msg = JSON.parse(trimmed) as Json;
    } catch {
      return [];
    }
    const at = this.now();
    const events: StepEvent[] = [];
    switch (msg.type) {
      case "system": {
        if (typeof msg.model === "string") this.model = msg.model;
        if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
        // Claude Code says outright when it refuses a tool call, and says why in words meant for a
        // person ("rm in '…' needs approval. The path is inside the working directories…"). Prefer
        // that to anything we could infer: it is structured, and it explains the actual reason.
        if (msg.subtype === "permission_denied") {
          const id = typeof msg.tool_use_id === "string" ? msg.tool_use_id : null;
          const reason = typeof msg.message === "string" ? msg.message.trim() : "";
          const ev = this.denial(id ?? `anon-denial-${this.deniedIds.size}`, at, {
            ...(reason ? { reason } : {}),
            ...(typeof msg.tool_name === "string" ? { toolName: msg.tool_name } : {}),
          });
          if (ev) events.push(ev);
        }
        break;
      }
      case "assistant": {
        const m = (msg.message ?? {}) as Json;
        if (typeof m.model === "string") this.model = m.model;
        const u = usageOf(m.usage);
        const id = typeof m.id === "string" ? m.id : `anon-${this.perMessage.size}`;
        if (u) this.perMessage.set(id, u);
        const content = Array.isArray(m.content) ? (m.content as Json[]) : [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            this.lastAssistantText = block.text;
            events.push({ type: "message", summary: short(block.text.trim(), 2000), at });
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            if (typeof block.id === "string") this.toolCalls.set(block.id, { name: block.name, input: block.input });
            events.push(toolUseToEvent(block.name, block.input, at));
          }
        }
        break;
      }
      case "user": {
        const m = (msg.message ?? {}) as Json;
        const content = Array.isArray(m.content) ? (m.content as Json[]) : [];
        for (const block of content) {
          if (block.type === "tool_result" && block.is_error === true) {
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
            if (id && DENIAL_TEXT.test(text)) {
              const ev = this.denial(id, at);
              if (ev) events.push(ev);
            } else {
              events.push({ type: "log", summary: short(`Tool error: ${short(block.content, 400)}`, 2000), at });
            }
          }
        }
        break;
      }
      case "result": {
        this.resultUsage = usageOf(msg.usage);
        this.resultText = typeof msg.result === "string" ? msg.result : null;
        this.isError = msg.is_error === true;
        this.subtype = typeof msg.subtype === "string" ? msg.subtype : null;
        this.numTurns = num(msg.num_turns);
        if (Array.isArray(msg.permission_denials)) {
          for (const d of msg.permission_denials as Json[]) {
            const id = typeof d.tool_use_id === "string" ? d.tool_use_id : `denial-${this.deniedIds.size}`;
            if (!this.toolCalls.has(id) && typeof d.tool_name === "string") this.toolCalls.set(id, { name: d.tool_name, input: d.tool_input });
            const ev = this.denial(id, at);
            if (ev) events.push(ev);
          }
        }
        break;
      }
    }
    return events;
  }

  /**
   * One `log` event per denied call, tagged with its approval category when it has one.
   *
   * `reason` is Claude Code's own explanation, when it gave one. It beats our wording because it
   * names the actual rule that stopped the call, so prefer it and keep the category as the tag the
   * server and the step summary group by.
   */
  private denial(id: string, at: string, from: { reason?: string; toolName?: string } = {}): StepEvent | null {
    if (this.deniedIds.has(id)) return null;
    this.deniedIds.add(id);
    const call = this.toolCalls.get(id) ?? { name: from.toolName ?? "unknown", input: undefined };
    const category = categorizeDenial(call.name, call.input);
    const what = toolUseToEvent(call.name, call.input, at).summary;
    if (category && !this.approvalsNeeded.includes(category)) this.approvalsNeeded.push(category);
    const ours = category ? `needs approval: ${category} (${what})` : `blocked: ${what} is not allowed in this step`;
    return {
      type: "log",
      summary: short(from.reason ? (category ? `needs approval: ${category} — ${from.reason}` : from.reason) : ours, 2000),
      at,
      data: {
        permission_denied: true,
        tool: call.name,
        ...(category ? { approval_needed: category } : {}),
        ...(from.reason ? { reason: short(from.reason, 500) } : {}),
      },
    };
  }

  get sawResult(): boolean {
    return this.subtype !== null || this.resultText !== null;
  }

  finalText(): string {
    return this.resultText ?? this.lastAssistantText;
  }

  usage(): TokenUsage {
    const sum: UsageNums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const u of this.perMessage.values()) {
      sum.input += u.input;
      sum.output += u.output;
      sum.cacheRead += u.cacheRead;
      sum.cacheWrite += u.cacheWrite;
    }
    const r = this.resultUsage;
    const pick = (a: number, b: number | undefined) => Math.max(a, b ?? 0);
    return {
      ...zeroUsage("claude", this.model),
      input_tokens: pick(sum.input, r?.input),
      output_tokens: pick(sum.output, r?.output),
      cache_read_tokens: pick(sum.cacheRead, r?.cacheRead),
      cache_write_tokens: pick(sum.cacheWrite, r?.cacheWrite),
    };
  }
}
