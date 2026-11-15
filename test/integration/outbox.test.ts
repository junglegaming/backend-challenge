import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { STRUCTURED_LOGGER, type StructuredLogger } from '../../src/application/ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/domain/ports/repositories';
import { systemClock } from '../../src/domain/ports/system';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { PrometheusMetrics } from '../../src/infrastructure/observability/metrics';
import {
  assertLedgerInvariant,
  countRows,
  createTestEnvironment,
  openWallet,
  purge,
  receiveAll,
  type RunningApp,
  startApp,
  submitWager,
  type TestEnvironment,
  wagerBody,
} from '../support/harness';

/**
 * Publishers are driven by hand (OUTBOX_ENABLED=false) so the test controls
 * the interleaving: concurrent publishers, a publisher that dies after the
 * claim, and a broker outage.
 */
let env: TestEnvironment;
let app: RunningApp;
let uow: UnitOfWork;
let logger: StructuredLogger;

const publisher = (overrides: { leaseMs?: number; sqs?: SqsGateway; instanceId?: string } = {}) =>
  new OutboxPublisher(uow, overrides.sqs ?? env.sqs, systemClock, new PrometheusMetrics(false), logger, {
    instanceId: overrides.instanceId ?? 'test',
    batchSize: 20,
    leaseMs: overrides.leaseMs ?? 30_000,
    pollIntervalMs: 10,
  });

const pendingCount = () => countRows(env, 'SELECT 1 FROM outbox_messages WHERE published_at IS NULL');

/** Generates N committed outbox events (each BET => Processed + BalanceChanged). */
const produce = async (bets: number) => {
  const wallet = await openWallet(app.url, '1000.00');
  await Promise.all(
    Array.from({ length: bets }, () => submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' }))),
  );
};

beforeAll(async () => {
  env = await createTestEnvironment({ OUTBOX_ENABLED: 'false', CONSUMER_ENABLED: 'false', PENDING_REFERENCE_ENABLED: 'false' });
  app = await startApp(env);
  uow = app.app.get(UNIT_OF_WORK);
  logger = app.app.get(STRUCTURED_LOGGER);
});
afterAll(async () => {
  await app.close();
  await assertLedgerInvariant(env);
  await env.teardown();
});

describe('transactional outbox', () => {
  test('two concurrent publishers share the work without double-claiming', async () => {
    await produce(40);
    const total = await pendingCount();
    expect(total).toBeGreaterThanOrEqual(80);
    await purge(env, 'events');

    const a = publisher({ instanceId: 'a' });
    const b = publisher({ instanceId: 'b' });
    const drain = async (p: OutboxPublisher) => {
      while (await p.tick()) {
        /* keep draining */
      }
    };
    await Promise.all([drain(a), drain(b), drain(a), drain(b)]);
    expect(await pendingCount()).toBe(0);

    const events = await receiveAll(env, 'events', { consume: true });
    const ids = events.map((m) => JSON.parse(m.Body!).eventId as string);
    const { rows } = await env.db.query('SELECT id FROM outbox_messages');
    expect(new Set(ids)).toEqual(new Set(rows.map((r: { id: string }) => r.id)));
    // claims are disjoint (SKIP LOCKED + lease): no event was published twice
    expect(ids.length).toBe(rows.length);
  });

  test('a publisher that dies after claiming is taken over once its lease expires', async () => {
    await produce(5);
    await purge(env, 'events');
    const expected = await pendingCount();

    // "instance A" claims the batch and dies before publishing (never calls send/mark)
    await uow.run((s) => s.outbox.claimBatch('dead-instance', 1_500, 100));
    const survivor = publisher({ instanceId: 'b' });
    expect(await survivor.tick()).toBe(false); // everything is leased to the dead instance
    expect(await pendingCount()).toBe(expected);

    await Bun.sleep(1_600);
    while (await survivor.tick()) {
      /* drain */
    }
    expect(await pendingCount()).toBe(0);
    const events = await receiveAll(env, 'events', { consume: true });
    expect(events.length).toBe(expected);
  });

  test('a republished event (crash after send, before mark) reaches consumers once: same eventId / dedup id', async () => {
    await produce(1);
    await purge(env, 'events');
    const [claimed] = await uow.run((s) => s.outbox.claimBatch('crashy', 300, 1));
    // "crashy" sends the event exactly like the publisher does... and dies before markPublished
    const { events: eventsUrl } = await env.sqs.queueUrls();
    await env.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: eventsUrl,
        MessageBody: JSON.stringify(claimed!.payload),
        MessageGroupId: claimed!.aggregateId,
        MessageDeduplicationId: claimed!.id,
      }),
    );
    await Bun.sleep(400); // lease expires
    const survivor = publisher({ instanceId: 'survivor' });
    while (await survivor.tick()) {
      /* drain: re-publishes the event */
    }
    expect(await countRows(env, 'SELECT 1 FROM outbox_messages WHERE id = $1 AND published_at IS NOT NULL', [claimed!.id])).toBe(1);
    const events = await receiveAll(env, 'events', { consume: true });
    const copies = events.filter((m) => JSON.parse(m.Body!).eventId === claimed!.id);
    // FIFO dedup drops the copy inside its 5 min window; beyond it consumers dedup by eventId
    expect(copies.length).toBe(1);
  });

  test('broker outage: publication is retried with backoff and nothing is lost', async () => {
    await produce(3);
    const before = await pendingCount();
    const broken = new SqsGateway(loadConfig({ ...env.env, AWS_ENDPOINT_URL: 'http://127.0.0.1:1' }));
    const failing = publisher({ sqs: broken, instanceId: 'offline' });
    await failing.tick().catch(() => undefined);
    broken.destroy();

    // still pending, with attempts recorded and a future retry time
    expect(await pendingCount()).toBe(before);
    expect(await countRows(env, 'SELECT 1 FROM outbox_messages WHERE published_at IS NULL AND attempts = 0')).toBe(0);
    expect(await countRows(env, 'SELECT 1 FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= now()')).toBe(0);

    // broker back: once due, a healthy publisher delivers everything
    await env.db.query(`UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL`);
    const healthy = publisher({ instanceId: 'online' });
    while (await healthy.tick()) {
      /* drain */
    }
    expect(await pendingCount()).toBe(0);
  });
});
