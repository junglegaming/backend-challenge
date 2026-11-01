import { pollUntil } from "./stack";

export const chaosEnvironment = {
  COMPOSE_PROFILES: "observability,chaos",
  APP_DB_HOST: "toxiproxy",
  APP_DB_PORT: "5432",
  APP_SQS_ENDPOINT: "http://toxiproxy:4566",
};
type ProxyName = "postgres" | "sqs";
const baseUrl = "http://127.0.0.1:18474";

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Toxiproxy control request failed (${response.status})`);
  return response;
}

export const toxiproxy = {
  async populate() {
    await pollUntil("Toxiproxy control API", async () => {
      try {
        return (await request("/version")).ok;
      } catch {
        return false;
      }
    });
    await request("/populate", "POST", [
      { name: "postgres", listen: "0.0.0.0:5432", upstream: "postgres:5432", enabled: true },
      { name: "sqs", listen: "0.0.0.0:4566", upstream: "ministack:4566", enabled: true },
    ]);
  },
  async enable(name: ProxyName, enabled: boolean) {
    await request(`/proxies/${name}`, "POST", { enabled });
  },
  async latency(name: ProxyName, milliseconds: number) {
    await request(`/proxies/${name}/toxics`, "POST", {
      name: "controlled_latency",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: milliseconds, jitter: 0 },
    });
  },
  async removeLatency(name: ProxyName) {
    await request(`/proxies/${name}/toxics/controlled_latency`, "DELETE");
  },
  async reset() {
    await request("/reset", "POST");
  },
};
