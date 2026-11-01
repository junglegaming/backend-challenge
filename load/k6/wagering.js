import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const fixtures = JSON.parse(open("/results/fixtures.json"));
const full = fixtures.profile === "full";
const phase = __ENV.LOAD_PHASE;
const stages = full
  ? [25, 100, 250, 500].map((target) => ({ target, duration: "30s" }))
  : [5, 15, 30].map((target) => ({ target, duration: "7s" }));
const executor = (execName) => ({
  executor: "ramping-arrival-rate", exec: execName, startRate: full ? 5 : 2,
  timeUnit: "1s", stages, preAllocatedVUs: full ? 100 : 30, maxVUs: 300,
  gracefulStop: "10s",
});
export const options = {
  scenarios: phase === "hot_plus_distributed"
    ? { hot: executor("hot"), distributed: executor("distributed") }
    : { workload: executor(phase === "hot_wallet" ? "hot" : "distributed") },
  thresholds: { unexpected_status: ["rate==0"], checks: ["rate==1"] },
  summaryTrendStats: ["min", "med", "p(95)", "p(99)", "max"],
  systemTags: ["status", "scenario", "method", "name", "expected_response"],
};
const unexpected = new Rate("unexpected_status");
const metrics = {};
for (const workload of ["hot", "distributed", "replay"]) {
  metrics[workload] = {
    requests: new Counter(`requests_${workload}`),
    committed: new Counter(`committed_${workload}`),
    backpressure: new Counter(`backpressure_${workload}`),
    duration: new Trend(`duration_${workload}`, true),
  };
}

function command(workload, index, commandPhase = phase) {
  const wallet = workload === "hot" ? fixtures.hot : fixtures.distributed[index % 1000];
  const key = `${fixtures.runId}:${commandPhase}:${workload}:${index}`;
  return { key, body: {
    providerId: "provider-a", externalTransactionId: key,
    walletId: wallet.id, playerId: wallet.playerId,
    roundId: "load-round", gameId: "load-game",
    kind: index % 2 === 0 ? "BET" : "WIN", money: { amount: "1.00", currency: "BRL" },
  } };
}

export function setup() {
  const response = http.post(
    "http://keycloak:8080/realms/wagering/protocol/openid-connect/token",
    { grant_type: "client_credentials", client_id: "provider-a", client_secret: __ENV.PROVIDER_A_SECRET },
    { tags: { name: "identity_setup" }, timeout: "10s" },
  );
  if (response.status !== 200) throw new Error("Load identity setup failed");
  const token = response.json();
  if (!token.access_token || token.expires_in < (full ? 180 : 90))
    throw new Error("Load identity token lifetime is insufficient");
  return { token: token.access_token, startedAt: Date.now() };
}

function submit(workload, data) {
  const index = exec.scenario.iterationInTest;
  const replay = phase === "replays" && index % 10 === 9;
  const replayFixture = replay ? fixtures.replays[Math.floor(index / 10) % fixtures.replays.length] : null;
  const request = replay ? command("distributed", replayFixture.index, "replay_seed") : command(workload, index);
  const metric = metrics[replay ? "replay" : workload];
  metric.requests.add(1);
  const response = http.post("http://nginx:3000/wagering/transactions", JSON.stringify(request.body), {
    headers: { Authorization: `Bearer ${data.token}`, "Content-Type": "application/json", "Idempotency-Key": request.key },
    tags: { name: "submit_wager" }, timeout: "15s",
    responseCallback: http.expectedStatuses(200, 503),
  });
  metric.duration.add(response.timings.duration);
  let valid = false;
  let transactionId = null;
  if (response.status === 200) {
    try {
      const body = response.json();
      valid = body.status === "PROCESSED" && body.idempotentReplay === replay
        && typeof body.transactionId === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.transactionId)
        && (!replay || body.transactionId === replayFixture.transactionId);
      if (valid) transactionId = body.transactionId;
    } catch (_) { /* Count malformed responses without logging payloads or headers. */ }
    metric.committed.add(1);
  } else if (response.status === 503) {
    valid = response.headers["Retry-After"] === "1";
    metric.backpressure.add(1);
  }
  unexpected.add(!valid);
  check(null, { "submission matches the expected contract": () => valid });
  console.log(JSON.stringify({
    workload: replay ? "replay" : workload, index, status: response.status, transactionId,
  }));
}
export function hot(data) { submit("hot", data); }
export function distributed(data) { submit("distributed", data); }

export function handleSummary(data) {
  // k6's legacy summary also contains setup_data (the bearer token). Persist metrics ONLY.
  return { [`/results/${phase}.json`]: JSON.stringify({
    runId: fixtures.runId, phase, profile: fixtures.profile, metrics: data.metrics,
  }, null, 2) };
}
