export interface PromSeries {
  metric: Record<string, string>;
  values: [number, string][];
}

const endpoint = `${process.env.LOAD_TARGET === "remote" ? process.env.LOAD_PROMETHEUS_URL : "http://127.0.0.1:19090"}/api/v1`;
export const healthyScrapeTimestamps =
  'timestamp(up{job="wagering"}) and (up{job="wagering"} == 1)';
async function query(path: string, parameters: Record<string, string>) {
  const response = await fetch(`${endpoint}/${path}?${new URLSearchParams(parameters)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Prometheus returned ${response.status}`);
  const body = (await response.json()) as {
    status: string;
    data: { result: { metric: Record<string, string>; value: [number, string] }[] };
  };
  if (body.status !== "success") throw new Error("Prometheus query failed");
  return body.data.result;
}

export function instant(expression: string, timeSeconds?: number) {
  return query("query", {
    query: expression,
    ...(timeSeconds === undefined ? {} : { time: String(timeSeconds) }),
  });
}

export async function phaseMetrics(startedAt: number, endedAt: number) {
  const expressions: Record<string, string> = {
    committed_per_second:
      'sum by(role,instance,channel) (rate(wagering_transactions_total{kind!="OPENING"}[30s]))',
    processing_attempts_per_second:
      "sum by(role,instance,channel) (rate(wagering_processing_duration_seconds_count[30s]))",
    processing_error_rate:
      '(sum by(role,instance,channel) (rate(wagering_processing_duration_seconds_count{status=~"transient|FAILED"}[30s])) or on(role,instance,channel) (0 * sum by(role,instance,channel) (rate(wagering_processing_duration_seconds_count[30s])))) / sum by(role,instance,channel) (rate(wagering_processing_duration_seconds_count[30s]))',
    lock_conflicts: "sum by(role,instance,reason) (increase(wagering_lock_conflicts_total[30s]))",
    lock_conflicts_cumulative: "wagering_lock_conflicts_total",
    processing_attempts_cumulative: "wagering_processing_duration_seconds_count",
    outbox_lag_seconds: "wagering_outbox_lag_seconds",
    outbox_published_per_second:
      "sum by(role,instance) (rate(wagering_outbox_published_total[30s]))",
    outbox_failed_per_second:
      "sum by(role,instance) (rate(wagering_outbox_publish_failures_total[30s]))",
    queue_depth: "wagering_sqs_queue_messages",
    up: 'up{job="wagering"}',
  };
  for (const [label, value] of [
    ["p50", "0.5"],
    ["p95", "0.95"],
    ["p99", "0.99"],
  ]) {
    expressions[`processing_${label}_seconds`] =
      `histogram_quantile(${value},sum by(le,role,instance,channel) (rate(wagering_processing_duration_seconds_bucket[30s])))`;
    expressions[`lock_wait_${label}_seconds`] =
      `histogram_quantile(${value},sum by(le,role,instance,channel) (rate(wagering_wallet_lock_wait_seconds_bucket[30s])))`;
  }
  const results: Record<string, { expression: string; series: PromSeries[] }> = {};
  await Promise.all(
    Object.entries(expressions).map(async ([name, expression]) => {
      const series = await query("query_range", {
        query: expression,
        start: String(startedAt / 1000),
        end: String(endedAt / 1000),
        step: "5",
      });
      results[name] = { expression, series: series as unknown as PromSeries[] };
    }),
  );
  return results;
}
