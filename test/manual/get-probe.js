import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const started = new Counter("read_started");
const completed = new Counter("read_completed");
const ok = new Counter("read_status_200");
const other = new Counter("read_status_other");
const unexpected = new Rate("read_unexpected");
const wholeCall = new Trend("read_whole_call_ms", true);
export const options = {
  scenarios: { transaction_get: {
    executor: "constant-arrival-rate", rate: 100, timeUnit: "1s", duration: "30s",
    preAllocatedVUs: 20, maxVUs: 20, gracefulStop: "15s",
  } },
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max"],
  thresholds: { checks: ["rate==1"], http_req_failed: ["rate==0"],
    read_unexpected: ["rate==0"], dropped_iterations: ["count==0"] },
};
export default function () {
  started.add(1);
  const before = Date.now();
  const response = http.get(`${__ENV.PROBE_BASE}/wagering/transactions/${__ENV.PROBE_TRANSACTION_ID}`, {
    headers: { Authorization: `Bearer ${__ENV.PROBE_TOKEN}` }, timeout: "15s", redirects: 0,
    responseType: "text", tags: { name: "transaction_get" },
    responseCallback: http.expectedStatuses(200),
  });
  wholeCall.add(Date.now() - before);
  completed.add(1);
  if (response.status === 200) ok.add(1); else other.add(1);
  let valid = false;
  try {
    const value = response.json();
    valid = response.status === 200 && value.transactionId === __ENV.PROBE_TRANSACTION_ID &&
      value.providerId === "provider-a" && value.externalTransactionId === __ENV.PROBE_EXTERNAL_ID &&
      value.walletId === __ENV.PROBE_WALLET_ID && value.status === "PROCESSED";
  } catch (_) { /* An invalid response is counted without exposing it. */ }
  check(null, { "expected transaction identity and status": () => valid });
  unexpected.add(!valid);
}
export function handleSummary(data) {
  const metrics = {};
  for (const name of ["read_started", "read_completed", "read_status_200", "read_status_other",
    "read_unexpected", "read_whole_call_ms", "http_req_duration", "http_req_failed", "checks", "dropped_iterations"]) {
    const metric = data.metrics[name];
    if (!metric) { metrics[name] = null; continue; }
    const values = {};
    for (const field of ["count", "rate", "passes", "fails", "avg", "min", "med", "p(95)", "p(99)", "max"])
      if (typeof metric.values[field] === "number" && Number.isFinite(metric.values[field])) values[field] = metric.values[field];
    const thresholds = {};
    for (const [name, result] of Object.entries(metric.thresholds ?? {})) thresholds[name] = result.ok;
    metrics[name] = { values, thresholds };
  }
  return { stdout: `${JSON.stringify({ probe: "manual-transaction-get", tool: "k6-2.3.0",
    configuredRate: 100, configuredSeconds: 30, configuredVUs: 20, metrics })}\n` };
}
