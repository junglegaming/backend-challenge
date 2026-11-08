import { randomBytes, randomUUID } from 'node:crypto';

const app = process.env.OBS_APP_URL ?? 'http://127.0.0.1:3000';
const jaeger = process.env.OBS_JAEGER_URL ?? 'http://127.0.0.1:16686';
const grafana = process.env.OBS_GRAFANA_URL ?? 'http://127.0.0.1:3001';
const prometheus = process.env.OBS_PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const username = process.env.OBS_GRAFANA_USER ?? 'admin';
const password = process.env.OBS_GRAFANA_PASSWORD ?? 'admin';
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON response');
  return value as Record<string, unknown>;
}

async function waitFor<T>(description: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 45000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timeout: ${description}`, { cause: lastError });
}

async function main(): Promise<void> {
  const ready = record(await getJson(`${app}/health/ready`));
  if (ready.status !== 'ok') throw new Error('Application is not ready');
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  await getJson(`${app}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', traceparent: `00-${traceId}-${parentId}-01` },
    body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } }),
  });
  const names = await waitFor('Jaeger HTTP, SQL and SQS spans', async () => {
    const body = record(await getJson(`${jaeger}/api/traces/${traceId}`));
    if (!Array.isArray(body.data) || !body.data[0]) return undefined;
    const trace = record(body.data[0]);
    if (!Array.isArray(trace.spans)) return undefined;
    const spans = trace.spans.map(record);
    const processes = record(trace.processes);
    const serviceExists = Object.values(processes).map(record).some((process) => process.serviceName === 'wagering-processor');
    const operations = spans.map((span) => span.operationName);
    if (!serviceExists || !['HTTP request', 'PostgreSQL query', 'SQS publish'].every((name) => operations.includes(name))) return undefined;
    const http = spans.find((span) => span.operationName === 'HTTP request');
    if (!http || !Array.isArray(http.references) ||
      !http.references.some((reference) => record(reference).spanID === parentId)) throw new Error('HTTP parent context not preserved');
    return operations;
  });
  const headers = { authorization };
  const dashboard = record(await getJson(`${grafana}/api/dashboards/uid/wagering-overview`, { headers }));
  const panels = record(dashboard.dashboard).panels;
  if (!Array.isArray(panels) || panels.length < 8) throw new Error('Provisioned Grafana dashboard incomplete');
  const source = record(await getJson(`${grafana}/api/datasources/uid/prometheus/health`, { headers }));
  if (source.status !== 'OK') throw new Error('Grafana Prometheus datasource unhealthy');
  await waitFor('Prometheus scrape of application metrics', async () => {
    const result = record(await getJson(`${prometheus}/api/v1/query?query=wager_lock_conflicts_total`));
    const data = record(result.data);
    return result.status === 'success' && Array.isArray(data.result) && data.result.length > 0 ? true : undefined;
  });
  console.log(JSON.stringify({ status: 'ok', traceId, spans: names.length, dashboard: 'wagering-overview', prometheus: 'scraping' }));
}

await main();
