import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PollingLoop, pause } from "../shared/application/polling-loop";
import { Database } from "../shared/infrastructure/database";
import { Dependencies, QUEUES } from "./health/dependencies";
import { WageringTelemetry } from "./wagering-telemetry";

@Injectable()
export class MetricSampler implements OnModuleInit, OnModuleDestroy {
  private readonly loop: PollingLoop;
  constructor(
    private readonly database: Database,
    private readonly dependencies: Dependencies,
    private readonly telemetry: WageringTelemetry,
  ) {
    this.loop = new PollingLoop(
      async (signal) => {
        await this.sample();
        await pause(1000, signal);
      },
      () => telemetry.logger.warning({ event: "metric_sample_failed" }),
    );
  }
  onModuleInit(): void {
    this.loop.start();
  }
  async sample(): Promise<void> {
    await Promise.all([this.sampleDatabase(), this.sampleQueues()]);
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
    await Promise.all(
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
  }
  async onModuleDestroy(): Promise<void> {
    await this.loop.stopWithin(2500);
  }
}
