import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PollingLoop, pause } from "../shared/application/polling-loop";
import { Database } from "../shared/infrastructure/database";
import { Dependencies, QUEUES } from "./health/dependencies";
import { WageringTelemetry } from "./wagering-telemetry";

@Injectable()
export class MetricSampler implements OnModuleInit, OnModuleDestroy {
  private readonly loops: PollingLoop[];
  constructor(
    private readonly database: Database,
    private readonly dependencies: Dependencies,
    private readonly telemetry: WageringTelemetry,
  ) {
    const loop = (work: () => Promise<void>, reason: string) =>
      new PollingLoop(
        async (signal) => {
          await work();
          await pause(1000, signal);
        },
        () => telemetry.logger.warning({ event: "metric_sample_failed", reason }),
      );
    // Each dependency retains its in-flight work until it settles. A stalled SQL
    // query neither overlaps with another SQL sample nor freezes healthy queues.
    this.loops = [
      loop(() => this.sampleDatabase(), "database"),
      loop(() => this.sampleQueues(), "queues"),
    ];
  }
  onModuleInit(): void {
    for (const loop of this.loops) loop.start();
  }
  async sample(): Promise<void> {
    const results = await Promise.allSettled([this.sampleDatabase(), this.sampleQueues()]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Metric sample failed");
  }
  private async sampleDatabase() {
    const orm = await this.database.orm;
    const [row] = await orm.em.getConnection().execute<{ lag: string; pending: number }[]>(`
      SELECT COALESCE(GREATEST(0, EXTRACT(EPOCH FROM now() - min(occurred_at))), 0)::text AS lag,
        (SELECT count(*)::int FROM wager_transactions WHERE status = 'PENDING_REFERENCE') AS pending
      FROM outbox_messages WHERE published_at IS NULL`);
    if (!row) return;
    this.telemetry.outboxLag.set(Number(row.lag));
    this.telemetry.pending.set(row.pending);
  }
  private async sampleQueues() {
    const results = await Promise.allSettled(
      Object.entries(QUEUES).map(async ([queue, name]) => {
        const attrs = await this.dependencies.queueAttributes(name);
        for (const [state, attr] of Object.entries({
          visible: "ApproximateNumberOfMessages",
          not_visible: "ApproximateNumberOfMessagesNotVisible",
          delayed: "ApproximateNumberOfMessagesDelayed",
        })) {
          const value = Number(attrs[attr as keyof typeof attrs]);
          if (Number.isFinite(value)) this.telemetry.queue.set({ queue, state }, value);
        }
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Queue sample failed");
  }
  async onModuleDestroy(): Promise<void> {
    const results = await Promise.all(this.loops.map((loop) => loop.stopWithin(2500)));
    this.telemetry.logger.info({
      event: "metric_sampler_stopped",
      drained: results.every(Boolean),
    });
  }
}
