import { setTimeout as delay } from "node:timers/promises";

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    /* Shutdown interrupts a pending backoff. */
  }
}

export class PollingLoop {
  private readonly controller = new AbortController();
  private work?: Promise<void>;
  constructor(
    private readonly step: (signal: AbortSignal) => Promise<void>,
    private readonly onError: () => void,
  ) {}
  start(): void {
    this.work ??= (async () => {
      while (!this.controller.signal.aborted) {
        try {
          await this.step(this.controller.signal);
        } catch {
          if (!this.controller.signal.aborted) {
            this.onError();
            await pause(1000, this.controller.signal);
          }
        }
      }
    })();
  }
  stop(): Promise<void> {
    this.controller.abort();
    return this.work ?? Promise.resolve();
  }
  async stopWithin(timeoutMs: number): Promise<boolean> {
    const timeout = new AbortController();
    try {
      return await Promise.race([
        this.stop().then(() => true),
        pause(timeoutMs, timeout.signal).then(() => false),
      ]);
    } finally {
      timeout.abort();
    }
  }
}
