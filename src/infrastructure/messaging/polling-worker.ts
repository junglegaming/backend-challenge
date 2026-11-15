import type { StructuredLogger } from '../../application/ports';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Template for background loops (outbox publisher, pending-reference resolver,
 * metrics sampler). A tick that did work is followed immediately by another
 * one (drain mode); an idle tick waits `intervalMs`. stop() lets the current
 * tick finish, so no work is abandoned half way.
 */
export abstract class PollingWorker {
  protected abstract readonly workerName: string;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  protected constructor(
    protected readonly logger: StructuredLogger,
    private readonly intervalMs: number,
  ) {}

  /** @returns true when the tick did work and the loop should continue right away */
  protected abstract tick(): Promise<boolean>;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.tick();
      } catch (error) {
        this.logger.error(`${this.workerName} tick failed`, { error: error instanceof Error ? error.message : String(error) });
      }
      if (!busy && this.running) {
        await Promise.race([sleep(this.intervalMs), new Promise<void>((resolve) => (this.wake = resolve))]);
        this.wake = undefined;
      }
    }
  }
}
