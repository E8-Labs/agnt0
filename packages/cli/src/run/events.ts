import type { StepEvent } from "@agnt0/protocol";
import { debug } from "../config.js";

export const MAX_EVENTS_PER_BATCH = 200;
const MAX_QUEUE = 2000;

/** Collects step events and POSTs them in batches (every `intervalMs`, at most 200 per request). */
export class EventBatcher {
  private queue: StepEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly send: (events: StepEvent[]) => Promise<void>,
    private readonly intervalMs = 2000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  push(e: StepEvent): void {
    this.queue.push({ ...e, summary: e.summary.slice(0, 2000) });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  get pending(): number {
    return this.queue.length;
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, MAX_EVENTS_PER_BATCH);
        try {
          await this.send(batch);
        } catch (e) {
          // Events are best effort: keep them for the next tick, never fail the step over them.
          debug("event batch failed", e);
          this.queue.unshift(...batch);
          if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
          break;
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
