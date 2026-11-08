import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OpenWallet } from '../../src/application/wagering/open-wallet';
import { MAX_REFERENCE_RETRIES, ProcessWagerTransaction, REFERENCE_TTL_MS } from '../../src/application/wagering/process-wager-transaction';
import { RetryPendingReference } from '../../src/application/wagering/retry-pending-reference';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-enums';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { PendingReferenceWorker } from '../../src/infrastructure/system/pending-reference-worker';
import { expectWalletMatchesLedger } from './support/http-app';
import { createTestDatabase, type TestDatabase } from './support/test-database';

let db: TestDatabase;
let now: Date;
let open: OpenWallet;
let process: ProcessWagerTransaction;
let retry: RetryPendingReference;
const clock = { now: () => new Date(now) };
const ids = { next: () => randomUUID() };

beforeAll(async () => {
  db = await createTestDatabase();
  now = new Date();
  const uow = new MikroOrmUnitOfWork(db.orm.em.fork());
  open = new OpenWallet(uow, clock, ids);
  process = new ProcessWagerTransaction(uow, clock, ids);
  retry = new RetryPendingReference(uow, clock, process);
});
afterAll(async () => {
  await db?.drop();
});

const advance = (ms: number) => { now = new Date(now.getTime() + ms); };

async function wallet(amount = '100.00') {
  return open.execute({ playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
}

function command(w: Awaited<ReturnType<typeof wallet>>, kind: WagerTransactionKind, amount: string, externalId = randomUUID(), reference?: string) {
  return {
    idempotencyKey: `key:${externalId}`, providerId: 'provider', externalTransactionId: externalId,
    walletId: w.id, playerId: w.playerId, roundId: 'round', gameId: 'game',
    kind, money: { amount, currency: 'BRL' }, referenceExternalTransactionId: reference,
  };
}

async function row(id: string) {
  const [result] = await db.run<{ status: string; failure_code: string | null; reference_retry_count: number; reference_next_attempt_at: string }>(
    'select status, failure_code, reference_retry_count, reference_next_attempt_at from wagering_transactions where id = ?', [id],
  );
  return result!;
}

describe('reference retry with real PostgreSQL', () => {
  test('ROLLBACK arrives before BET, is retried and applied once after BET commits', async () => {
    const w = await wallet();
    const betId = randomUUID();
    const rollback = command(w, WagerTransactionKind.Rollback, '80.00', randomUUID(), betId);
    const pending = await process.execute(rollback);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await retry.runOne()).toBe(false);
    expect((await process.execute(command(w, WagerTransactionKind.Bet, '80.00', betId))).balance?.amount).toBe('20.00');
    advance(1000);
    expect(await retry.runOne()).toBe(true);
    expect((await row(pending.transactionId)).status).toBe('PROCESSED');
    const replay = await process.execute(rollback);
    expect(replay).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' }, idempotentReplay: true });
    expect(await db.run('select id from wallet_ledger_entries where transaction_id = ?', [pending.transactionId])).toHaveLength(1);
    expect(await db.run("select id from outbox_messages where event_type = 'WagerTransactionProcessed' and payload->>'correlationId' = ?", [pending.transactionId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('two pending reversals of one BET race and only one succeeds', async () => {
    const w = await wallet();
    const bet = randomUUID();
    const a = await process.execute(command(w, WagerTransactionKind.Refund, '10.00', randomUUID(), bet));
    const b = await process.execute(command(w, WagerTransactionKind.Rollback, '10.00', randomUUID(), bet));
    await process.execute(command(w, WagerTransactionKind.Bet, '10.00', bet));
    advance(1000);
    expect(await Promise.all([retry.runOne(), retry.runOne()])).toEqual([true, true]);
    const outcomes = await Promise.all([row(a.transactionId), row(b.transactionId)]);
    expect(outcomes.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(outcomes.find((r) => r.status === 'REJECTED')?.failure_code).toBe('ALREADY_REVERSED');
    expect(await db.run('select id from wallet_ledger_entries where transaction_id in (?, ?)', [a.transactionId, b.transactionId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('ROLLBACK of WIN that has been spent is rejected without a debit', async () => {
    const w = await wallet('0.00');
    const win = randomUUID();
    const pending = await process.execute(command(w, WagerTransactionKind.Rollback, '40.00', randomUUID(), win));
    await process.execute(command(w, WagerTransactionKind.Win, '40.00', win));
    await process.execute(command(w, WagerTransactionKind.Bet, '35.00'));
    advance(1000);
    expect(await retry.runOne()).toBe(true);
    expect(await row(pending.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REVERSAL_WOULD_OVERDRAW' });
    expect(await db.run('select id from wallet_ledger_entries where transaction_id = ?', [pending.transactionId])).toHaveLength(0);
    expect(await db.run("select id from outbox_messages where event_type = 'WagerTransactionRejected' and payload->>'correlationId' = ?", [pending.transactionId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('persisted exponential backoff and retry exhaustion commit REFERENCE_NOT_FOUND and one rejection event', async () => {
    const w = await wallet();
    const pending = await process.execute(command(w, WagerTransactionKind.Refund, '1.00', randomUUID(), randomUUID()));
    for (let attempt = 1; attempt <= MAX_REFERENCE_RETRIES; attempt++) {
      advance(1000 * 2 ** (attempt - 1));
      expect(await retry.runOne()).toBe(true);
      const state = await row(pending.transactionId);
      if (attempt < MAX_REFERENCE_RETRIES) {
        expect(state).toMatchObject({ status: 'PENDING_REFERENCE', reference_retry_count: attempt });
        expect(new Date(state.reference_next_attempt_at).getTime() - now.getTime()).toBe(1000 * 2 ** attempt);
        expect(await retry.runOne()).toBe(false);
      } else {
        expect(state).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_retry_count: MAX_REFERENCE_RETRIES });
      }
    }
    expect(await db.run("select id from outbox_messages where event_type = 'WagerTransactionRejected' and payload->>'correlationId' = ?", [pending.transactionId])).toHaveLength(1);
    expect(await db.run('select id from wallet_ledger_entries where transaction_id = ?', [pending.transactionId])).toHaveLength(0);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('TTL expires even with retries remaining', async () => {
    const w = await wallet();
    const pending = await process.execute(command(w, WagerTransactionKind.Refund, '1.00', randomUUID(), randomUUID()));
    advance(REFERENCE_TTL_MS);
    expect(await retry.runOne()).toBe(true);
    expect(await row(pending.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('reference lookup is scoped to provider; an external id from another provider is not used', async () => {
    const w = await wallet();
    const ref = randomUUID();
    await process.execute(command(w, WagerTransactionKind.Bet, '5.00', ref));
    const pending = await process.execute({ ...command(w, WagerTransactionKind.Refund, '5.00', randomUUID(), ref), providerId: 'other' });
    advance(1000);
    expect(await retry.runOne()).toBe(true);
    expect(await row(pending.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_retry_count: 1 });
    advance(REFERENCE_TTL_MS);
    expect(await retry.runOne()).toBe(true);
    expect(await row(pending.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('reprocessing validates reference context, kind and amount before applying a reversal', async () => {
    const w = await wallet();
    const other = await wallet();
    const cases = [
      { reference: command(other, WagerTransactionKind.Bet, '5.00'), change: {}, failure: 'REFERENCE_MISMATCH' },
      { reference: command(w, WagerTransactionKind.Bet, '5.00'), change: { roundId: 'different' }, failure: 'REFERENCE_MISMATCH' },
      { reference: command(w, WagerTransactionKind.Win, '5.00'), change: {}, failure: 'INVALID_REFERENCE_KIND' },
      { reference: command(w, WagerTransactionKind.Bet, '6.00'), change: {}, failure: 'AMOUNT_MISMATCH' },
    ];
    for (const item of cases) {
      const pending = await process.execute({ ...command(w, WagerTransactionKind.Refund, '5.00', randomUUID(), item.reference.externalTransactionId), ...item.change });
      await process.execute(item.reference);
      advance(1000);
      expect(await retry.runOne()).toBe(true);
      expect(await row(pending.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: item.failure });
      expect(await db.run('select id from wallet_ledger_entries where transaction_id = ?', [pending.transactionId])).toHaveLength(0);
    }
    await expectWalletMatchesLedger(db, w.id);
    await expectWalletMatchesLedger(db, other.id);
  });

  test('outbox failure rolls back wallet, ledger and pending outcome; a later retry succeeds', async () => {
    const w = await wallet();
    const bet = randomUUID();
    const pending = await process.execute(command(w, WagerTransactionKind.Rollback, '20.00', randomUUID(), bet));
    await process.execute(command(w, WagerTransactionKind.Bet, '20.00', bet));
    advance(1000);
    await db.run(`create function test_reject_outbox() returns trigger language plpgsql as $$
      begin raise exception 'test outbox failure'; end $$`);
    await db.run('create trigger test_reject_outbox before insert on outbox_messages for each row execute function test_reject_outbox()');
    try {
      await expect(retry.runOne()).rejects.toThrow('test outbox failure');
    } finally {
      await db.run('drop trigger test_reject_outbox on outbox_messages');
      await db.run('drop function test_reject_outbox()');
    }
    expect(await row(pending.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_retry_count: 0 });
    expect(await db.run('select id from wallet_ledger_entries where transaction_id = ?', [pending.transactionId])).toHaveLength(0);
    expect(await retry.runOne()).toBe(true);
    expect((await row(pending.transactionId)).status).toBe('PROCESSED');
    await expectWalletMatchesLedger(db, w.id);
  });

  test('SKIP LOCKED allows another worker to claim the next due row', async () => {
    const a = await wallet();
    const b = await wallet();
    const pendingA = await process.execute(command(a, WagerTransactionKind.Refund, '1.00', randomUUID(), randomUUID()));
    const pendingB = await process.execute(command(b, WagerTransactionKind.Refund, '1.00', randomUUID(), randomUUID()));
    advance(1000);
    const holder = db.orm.em.fork();
    await holder.begin();
    try {
      await holder.getConnection().execute('select id from wagering_transactions where id = ? for no key update', [pendingA.transactionId], 'all', holder.getTransactionContext());
      expect(await retry.runOne()).toBe(true);
      expect((await row(pendingA.transactionId)).reference_retry_count).toBe(0);
      expect((await row(pendingB.transactionId)).reference_retry_count).toBe(1);
    } finally {
      await holder.rollback();
    }
    advance(REFERENCE_TTL_MS);
    expect(await retry.runOne()).toBe(true);
    expect(await retry.runOne()).toBe(true);
    await expectWalletMatchesLedger(db, a.id);
    await expectWalletMatchesLedger(db, b.id);
  });

  test('scheduled worker processes due entries and shuts down cleanly', async () => {
    const w = await wallet();
    const bet = randomUUID();
    const pending = await process.execute(command(w, WagerTransactionKind.Rollback, '10.00', randomUUID(), bet));
    await process.execute(command(w, WagerTransactionKind.Bet, '10.00', bet));
    advance(1000);
    const worker = new PendingReferenceWorker(retry);
    worker.onModuleInit();
    try {
      const deadline = Date.now() + 5000;
      while ((await row(pending.transactionId)).status === 'PENDING_REFERENCE' && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      expect((await row(pending.transactionId)).status).toBe('PROCESSED');
    } finally {
      await worker.onModuleDestroy();
    }
    await expectWalletMatchesLedger(db, w.id);
  });
});
