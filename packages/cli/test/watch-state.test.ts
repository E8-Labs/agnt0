import { describe, expect, it } from "vitest";
import type { RealtimeEvent } from "@agnt0/protocol";
import { initialWatchState, reduceWatch } from "../src/watch/state.js";

const started = (stepId: string): RealtimeEvent => ({
  type: "step.started",
  step_id: stepId,
  ticket_id: "tkt_1",
  role: "backend_developer",
  at: "2026-10-15T10:00:00Z",
});

const completed = (stepId: string, over: Partial<Extract<RealtimeEvent, { type: "step.completed" }>> = {}): RealtimeEvent => ({
  type: "step.completed",
  step_id: stepId,
  outcome: "succeeded",
  credits_charged: 4,
  tokens: 90_000,
  at: "2026-10-15T10:04:00Z",
  ...over,
});

const apply = (events: RealtimeEvent[]) => events.reduce(reduceWatch, initialWatchState);

describe("watch state", () => {
  it("totals what compression saved, and leaves it off a step that saved nothing", () => {
    const state = apply([
      started("stp_1"),
      completed("stp_1", { tokens_saved: 7_800 }),
      started("stp_2"),
      completed("stp_2"), // no compression on this step
    ]);
    expect(state.savedTokens).toBe(7_800);
    expect(state.tiles.find((t) => t.stepId === "stp_1")?.tokensSaved).toBe(7_800);
    // Null, not zero: this step read no compressed output, which is not the same as saving nothing.
    expect(state.tiles.find((t) => t.stepId === "stp_2")?.tokensSaved).toBeNull();
  });

  it("keeps the credits and tokens a finished step reported", () => {
    const state = apply([started("stp_1"), completed("stp_1", { credits_charged: 6, tokens: 120_000 })]);
    const tile = state.tiles[0]!;
    expect(tile.status).toBe("succeeded");
    expect(tile.credits).toBe(6);
    expect(tile.tokens).toBe(120_000);
    expect(state.feed[0]?.text).toContain("6 credits");
  });
});
