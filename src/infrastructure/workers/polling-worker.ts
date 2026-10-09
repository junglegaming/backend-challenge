import type { AppLogger } from "../../shared/application/observability";

/**
 * Base loop for background workers: runs `tick()` repeatedly, sleeping `idleMs` when there was no work,
 * with an interruptible sleep so shutdown is immediate. Errors are logged and backed off, never fatal.
 */
export abstract class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  protected constructor(
    readonly name: string,
    protected readonly logger: AppLogger,
    private readonly idleMs: number,
  ) {}

  /** Returns true when it did work (loop again immediately), false when idle. */
  protected abstract tick(): Promise<boolean>;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ worker: this.name }, "worker started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    await this.onStopped();
    this.logger.info({ worker: this.name }, "worker stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  protected async onStopped(): Promise<void> {}

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let didWork = false;
      try {
        didWork = await this.tick();
        failures = 0;
      } catch (error) {
        failures++;
        this.logger.warn({ worker: this.name, err: error, failures }, "worker iteration failed");
      }
      if (!this.running) break;
      if (!didWork || failures > 0) {
        await this.sleep(failures > 0 ? Math.min(this.idleMs * 2 ** failures, 30_000) : this.idleMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
