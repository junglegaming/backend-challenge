import { Connection } from "@mikro-orm/core";
import { QUEUES } from "../src/observability/health/dependencies";

export function remoteSampler(connection: Connection, depth: (queue: string) => Promise<number>) {
  const samples: unknown[] = [];
  let active: Promise<void> | undefined;
  let failure: unknown;
  const take = () => {
    if (active || failure) return;
    active = (async () => {
      const [sql] = await connection.execute(`SELECT
        (SELECT count(*)::int FROM outbox_messages) AS events,
        (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
        (SELECT extract(epoch FROM clock_timestamp()-min(occurred_at)) FROM outbox_messages
          WHERE published_at IS NULL) AS oldest_unpublished_seconds,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters`);
      samples.push({
        at: Date.now(),
        sql,
        requests: await depth(QUEUES.requests),
        events: await depth(QUEUES.events),
        cpu: process.cpuUsage(),
        rssBytes: process.memoryUsage().rss,
      });
    })()
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        active = undefined;
      });
  };
  take();
  const timer = setInterval(take, 5000);
  return async () => {
    clearInterval(timer);
    await active;
    return {
      intervalMs: 5000,
      processScope: "Bun orchestration, SQL and event observer share one process",
      failed: Boolean(failure),
      samples,
    };
  };
}
