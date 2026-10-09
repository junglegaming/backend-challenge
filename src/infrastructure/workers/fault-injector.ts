/**
 * Test-only crash points. In production `points` is always empty (config ignores FAULT_INJECTION there),
 * so `hit()` is a no-op. In tests it kills the process abruptly — no shutdown hooks, no finally blocks —
 * which is exactly what "the process died between commit and ack" means.
 */
export type FaultPoint =
  | "after-commit-before-ack"
  | "after-claim-before-publish"
  | "after-publish-before-mark";

/** Points that throw an unexpected error instead of crashing (simulates a defect). */
export type ErrorFaultPoint = "consumer-unexpected-error";

export class FaultInjector {
  private readonly points: ReadonlySet<string>;

  constructor(points: readonly string[]) {
    this.points = new Set(points);
  }

  get enabled(): boolean {
    return this.points.size > 0;
  }

  throwIf(point: ErrorFaultPoint): void {
    if (this.points.has(point)) throw new Error(`fault injection: ${point}`);
  }

  async hit(point: FaultPoint): Promise<void> {
    if (!this.points.has(point)) return;
    process.stderr.write(`\n[fault-injection] crashing at ${point}\n`);
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      // ignore and fall through
    }
    process.exit(137);
  }
}
