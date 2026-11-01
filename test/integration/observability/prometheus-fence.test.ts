import { expect, test } from "bun:test";
import { healthyScrapeTimestamps, instant, type PromSeries } from "../../../load/prometheus";
import { pollUntil } from "../../support/stack";

if (process.env.WAGERING_STACK_MANAGED !== "1") throw new Error("Use the declared stack suite");

const identity = (metric: Record<string, string>) =>
  `${metric.job}/${metric.instance}/${metric.role}`;

test("scrape fence uses actual healthy sample times instead of the query evaluation time", async () => {
  const gap = await pollUntil(
    "eight healthy histories with an observed gap between scrapes",
    async () => {
      const response = await fetch(
        `http://127.0.0.1:19090/api/v1/query?${new URLSearchParams({ query: 'up{job="wagering"}[2m]' })}`,
        { signal: AbortSignal.timeout(5000) },
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as {
        status: string;
        data: { resultType: string; result: PromSeries[] };
      };
      expect(body.status).toBe("success");
      expect(body.data.resultType).toBe("matrix");
      const series = body.data.result;
      if (series.length !== 8 || series.some((item) => item.values.length < 2)) return false;
      const histories = series.map((item) => ({
        identity: identity(item.metric),
        samples: item.values.map(([time, value]) => ({ ms: Math.round(time * 1000), value })),
      }));
      const lower = Math.max(...histories.map((item) => item.samples[0]?.ms ?? Infinity));
      const upper = Math.min(...histories.map((item) => item.samples.at(-1)?.ms ?? -Infinity));
      const times = [
        ...new Set(histories.flatMap((item) => item.samples.map((sample) => sample.ms))),
      ]
        .filter((ms) => ms >= lower && ms <= upper)
        .sort((a, b) => a - b);
      for (let index = 1; index < times.length; index++) {
        const before = times[index - 1];
        const after = times[index];
        if (before === undefined || after === undefined || after - before < 4) continue;
        const evaluationMs = Math.floor((before + after) / 2);
        const expected = histories.map((item) => ({
          identity: item.identity,
          sample: item.samples.filter((sample) => sample.ms < evaluationMs).at(-1),
        }));
        if (expected.some((item) => item.sample?.value !== "1")) continue;
        return { evaluationMs, expected, before, after };
      }
      return false;
    },
    25_000,
    250,
  );
  expect(gap.evaluationMs).toBeGreaterThan(gap.before);
  expect(gap.evaluationMs).toBeLessThan(gap.after);
  const stamps = await instant(healthyScrapeTimestamps, gap.evaluationMs / 1000);
  expect(stamps).toHaveLength(8);
  expect(new Set(stamps.map((series) => identity(series.metric))).size).toBe(8);
  for (const series of stamps) {
    const expected = gap.expected.find((item) => item.identity === identity(series.metric));
    if (!expected?.sample) throw new Error("Sample identity missing from the observed history");
    expect(Math.round(Number(series.value[1]) * 1000)).toBe(expected.sample.ms);
    expect(Math.round(Number(series.value[1]) * 1000)).toBeLessThan(gap.evaluationMs);
    expect(Math.round(series.value[0] * 1000)).toBe(gap.evaluationMs);
  }
  // Positive control: the old placement of timestamp incorrectly calls these samples fresh.
  const old = await instant('timestamp(up{job="wagering"} == 1)', gap.evaluationMs / 1000);
  expect(old).toHaveLength(8);
  for (const series of old)
    expect(Math.round(Number(series.value[1]) * 1000)).toBe(gap.evaluationMs);
}, 30_000);
