import { expect, test } from 'bun:test';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';

test('exports counters, histogram and live probes', async () => {
  const metrics = new PrometheusMetrics();
  metrics.transaction('PROCESSED');
  metrics.duplicate('inbox');
  metrics.retry('reference');
  metrics.lockConflict();
  metrics.latency('sqs', 0.1);
  metrics.configureProbes(async () => 12, async () => 3);
  const text = await metrics.render();
  expect(text).toContain('wager_transactions_total{status="PROCESSED"} 1');
  expect(text).toContain('wager_duplicates_total{source="inbox"} 1');
  expect(text).toContain('wager_retries_total{source="reference"} 1');
  expect(text).toContain('wager_lock_conflicts_total 1');
  expect(text).toContain('wager_operation_duration_seconds_count{operation="sqs"} 1');
  expect(text).toContain('wager_outbox_oldest_unpublished_seconds 12');
  expect(text).toContain('wager_dlq_messages 3');
  metrics.configureProbes(async () => { throw new Error('offline'); }, async () => 0);
  await expect(metrics.render()).rejects.toThrow('offline');
});
