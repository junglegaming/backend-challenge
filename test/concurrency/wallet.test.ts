import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError } from '../../src/application/errors';
import { ResolvePendingReferences } from '../../src/application/resolve-pending-references';
import { config } from '../../src/config';
import { freshDatabase, harness } from '../support';

/**
 * Paralelismo real: cada chamada abre a própria transação em uma conexão diferente do pool, e é
 * o Postgres que arbitra. Não há mock nem execução sequencial disfarçada.
 */
let orm: MikroORM;
let h: ReturnType<typeof harness>;

beforeAll(async () => {
  orm = await freshDatabase();
  h = harness(orm);
});
afterAll(async () => {
  await h.assertLedgerConsistent();
  await orm.close();
});

const debits = (walletId: string) => h.sql(`select amount from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);

describe('concurrency on a single wallet', () => {
  test('the same bet sent 50 times in parallel produces a single debit', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => h.send(bet)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance.amount === '90.00')).toBe(true);
    expect(await debits(wallet.id)).toHaveLength(1);
    expect(await h.balance(wallet.id)).toBe('90.00');
    await h.assertLedgerConsistent(wallet.id);
  });

  test('mandatory scenario: 100.00, two simultaneous bets of 80.00', async () => {
    const wallet = await h.wallet('100.00');
    const [a, b] = [h.payload(wallet, 'BET', '80.00'), h.payload(wallet, 'BET', '80.00')];
    const results = await Promise.all([h.send(a), h.send(b)]);

    expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')!.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await h.balance(wallet.id)).toBe('20.00');
    expect(await debits(wallet.id)).toHaveLength(1);

    // nenhum retry duplica o débito
    const retries = await Promise.all([h.send(a), h.send(b), h.send(a), h.send(b)]);
    expect(retries.every((r) => r.idempotentReplay)).toBe(true);
    expect(await debits(wallet.id)).toHaveLength(1);
    expect(await h.balance(wallet.id)).toBe('20.00');
    await h.assertLedgerConsistent(wallet.id);
  });

  test('hot wallet: 100 concurrent bets of 1.00 against 50.00 — exactly 50 win the race', async () => {
    const wallet = await h.wallet('50.00');
    const results = await Promise.all(Array.from({ length: 100 }, () => h.send(h.payload(wallet, 'BET', '1.00'))));

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(50);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(50);
    expect(await h.balance(wallet.id)).toBe('0.00');
    expect(await debits(wallet.id)).toHaveLength(50);
    const [row] = await h.sql(`select version from wallets where id = ?`, [wallet.id]);
    expect(row!.version).toBe(51); // nenhum lost update: uma versão por mudança de saldo
    await h.assertLedgerConsistent(wallet.id);
  });

  test('mixed debits and credits in parallel never lose an update', async () => {
    const wallet = await h.wallet('1000.00');
    const operations = Array.from({ length: 60 }, (_, i) => h.payload(wallet, i % 3 === 0 ? 'WIN' : 'BET', i % 3 === 0 ? '7.00' : '3.00'));
    await Promise.all(operations.map((op) => h.send(op)));
    // 20 WIN de 7.00 (+140) e 40 BET de 3.00 (-120)
    expect(await h.balance(wallet.id)).toBe('1020.00');
    await h.assertLedgerConsistent(wallet.id);
  });

  test('concurrent REFUND and ROLLBACK of the same bet: only one reverses it', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '40.00');
    await h.send(bet);
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    const results = await Promise.all([
      h.send(h.payload(wallet, 'REFUND', '40.00', ref)),
      h.send(h.payload(wallet, 'ROLLBACK', '40.00', ref)),
      h.send(h.payload(wallet, 'REFUND', '40.00', ref)),
    ]);
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(2);
    expect(await h.balance(wallet.id)).toBe('100.00');
    await h.assertLedgerConsistent(wallet.id);
  });

  test('same idempotency key racing on two different wallets: one wins, the other is a conflict', async () => {
    const [w1, w2] = await Promise.all([h.wallet('100.00'), h.wallet('100.00')]);
    const outcomes = await Promise.allSettled([
      h.send(h.payload(w1, 'BET', '10.00'), 'shared-key'),
      h.send(h.payload(w2, 'BET', '10.00'), 'shared-key'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(IdempotencyConflictError);
    const balances = [await h.balance(w1.id), await h.balance(w2.id)].sort();
    expect(balances).toEqual(['100.00', '90.00']);
  });
});

describe('concurrency across wallets', () => {
  test('distinct wallets are processed in parallel and each stays consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => h.wallet('100.00')));
    const results = await Promise.all(wallets.flatMap((wallet) => Array.from({ length: 10 }, () => h.send(h.payload(wallet, 'BET', '5.00')))));
    expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) expect(await h.balance(wallet.id)).toBe('50.00');
    await h.assertLedgerConsistent();
  });

  test('a locked wallet does not block other wallets', async () => {
    const [busy, free] = await Promise.all([h.wallet('100.00'), h.wallet('100.00')]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // segura o lock da wallet `busy` dentro de uma transação aberta
    const holder = h.uow.run(async (store) => {
      await store.lockWallet(busy.id);
      await held;
    });
    await Bun.sleep(50);
    const blocked = h.send(h.payload(busy, 'BET', '1.00'));
    const fast = await h.send(h.payload(free, 'BET', '1.00')); // conclui com `busy` ainda travada
    expect(fast.status).toBe('PROCESSED');
    expect(await Promise.race([blocked.then(() => 'done'), Bun.sleep(200).then(() => 'waiting')])).toBe('waiting');
    release();
    await holder;
    expect((await blocked).status).toBe('PROCESSED');
  });
});

describe('references delivered out of order', () => {
  const resolver = () => new ResolvePendingReferences(h.uow);
  const makeDue = (transactionId: string) => h.sql(`update wager_transactions set next_attempt_at = now() - interval '1 minute' where id = ?`, [transactionId]);
  const status = async (transactionId: string) => (await h.sql(`select status, failure_code, attempts from wager_transactions where id = ?`, [transactionId]))[0]!;

  test('REFUND and ROLLBACK arriving before their reference are applied once it shows up', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '30.00');
    const win = h.payload(wallet, 'WIN', '50.00');
    const refund = await h.send(h.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    const rollback = await h.send(h.payload(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect([refund.status, rollback.status]).toEqual(['PENDING_REFERENCE', 'PENDING_REFERENCE']);
    expect(await h.balance(wallet.id)).toBe('100.00');

    // ainda sem referência: o worker tenta de novo e reagenda com backoff
    await makeDue(refund.transactionId);
    await resolver().runOnce();
    expect(await status(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 2 });

    await h.send(bet); // 70.00
    await h.send(win); // 120.00
    await Promise.all([makeDue(refund.transactionId), makeDue(rollback.transactionId)]);
    // três "instâncias" do worker ao mesmo tempo: cada pendência é resolvida uma única vez
    await Promise.all([resolver().runOnce(), resolver().runOnce(), resolver().runOnce()]);

    expect((await status(refund.transactionId)).status).toBe('PROCESSED');
    expect((await status(rollback.transactionId)).status).toBe('PROCESSED');
    expect(await h.balance(wallet.id)).toBe('100.00'); // 100 - 30 + 50 + 30 - 50
    expect(await h.sql(`select 1 from wallet_ledger_entries where transaction_id in (?, ?)`, [refund.transactionId, rollback.transactionId])).toHaveLength(2);
    await h.assertLedgerConsistent(wallet.id);

    // o replay da requisição original agora devolve o resultado final
    const replay = await h.send(h.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId, externalTransactionId: 'never-sent' }));
    expect(replay.failureCode).toBe('ALREADY_REVERSED');
  });

  test('when attempts run out the transaction is REJECTED as REFERENCE_NOT_FOUND and the event is published', async () => {
    const wallet = await h.wallet('100.00');
    const previous = config.pendingReference.maxAttempts;
    config.pendingReference.maxAttempts = 2;
    try {
      const refund = await h.send(h.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: 'never-arrives' }));
      await makeDue(refund.transactionId);
      await resolver().runOnce(); // tentativa 2
      await makeDue(refund.transactionId);
      await resolver().runOnce(); // limite atingido
      expect(await status(refund.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
      const events = await h.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by sequence`, [refund.transactionId]);
      expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
      expect(await h.balance(wallet.id)).toBe('100.00');
    } finally {
      config.pendingReference.maxAttempts = previous;
    }
  });
});
