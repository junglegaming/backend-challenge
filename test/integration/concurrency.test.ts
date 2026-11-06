import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppService } from '../../src/app.service';
import { Kind } from '../../src/domain/wager';
import { metrics } from '../../src/metrics';

describe('PostgreSQL financial concurrency (containers required)', () => {
  let db: DataSource;
  let service: AppService;
  const wallets: string[] = [];
  const runId = randomUUID();
  const externalId = (id: string) => `${runId}:${id}`;
  const idempotencyKey = (key: string) => `${runId}:${key}`;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error('Set DATABASE_URL and apply migrations before integration tests');
    db = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL });
    await db.initialize();
    service = new AppService(db);
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });
  const wallet = async (balance: string) => {
    const created = await service.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    wallets.push(created.id);
    return created;
  };
  afterEach(async () => {
    for (const id of wallets) expect((await service.reconcile(id))?.consistent).toBe(true);
    wallets.splice(0);
  });
  const submit = (input: Parameters<AppService['submit']>[0], key: string) =>
    service.submit(
      {
        ...input,
        externalTransactionId: externalId(input.externalTransactionId),
        ...(input.referenceExternalTransactionId
          ? { referenceExternalTransactionId: externalId(input.referenceExternalTransactionId) }
          : {}),
      },
      idempotencyKey(key),
    );
  const bet = (
    w: { id: string; playerId: string },
    external: string,
    key: string,
    amount = '80.00',
  ) =>
    submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: external,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Bet,
        money: { amount, currency: 'BRL' },
      },
      key,
    );
  test('50 simultaneous deliveries of an identical operation create one debit', async () => {
    const w = await wallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => bet(w, 'duplicate-50', 'same-key', '25.00')),
    );
    expect(new Set(results.map((r) => ('transactionId' in r ? r.transactionId : ''))).size).toBe(1);
    const balance = await service.wallet(w.id);
    expect(balance?.balance.amount).toBe('75.00');
    const ledger = await db.query(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'",
      [w.id],
    );
    expect(ledger[0].count).toBe(1);
  });
  test('simultaneous bets cannot spend a wallet twice', async () => {
    const w = await wallet('100.00');
    const results = await Promise.all([
      bet(w, 'race-a', 'race-key-a'),
      bet(w, 'race-b', 'race-key-b'),
    ]);
    expect(results.filter((r) => 'status' in r && r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => 'status' in r && r.status === 'REJECTED')).toHaveLength(1);
    const balance = await service.wallet(w.id);
    expect(balance?.balance.amount).toBe('20.00');
    const ledger = await db.query(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'",
      [w.id],
    );
    expect(ledger[0].count).toBe(1);
  });
  test('an out-of-order refund is retried after its bet commits', async () => {
    const w = await wallet('50.00');
    const pending = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'refund-first',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-later',
      },
      'refund-first-key',
    );
    expect('status' in pending && pending.status).toBe('PENDING_REFERENCE');
    await bet(w, 'bet-later', 'bet-later-key', '20.00');
    await db.query('UPDATE wager_transactions SET next_attempt_at=now() WHERE idempotency_key=$1', [
      idempotencyKey('refund-first-key'),
    ]);
    await service.retryPendingReferences();
    const refund = await service.byExternal('integration-provider', externalId('refund-first'));
    expect(refund.status).toBe('PROCESSED');
    expect((await service.wallet(w.id))?.balance.amount).toBe('50.00');
    const entries = await db.query(
      'SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id=$1',
      [w.id],
    );
    expect(entries[0].count).toBe(3);
  });
  test('invalid references are rejected for mismatched wallet, round, and operation kind', async () => {
    const w = await wallet('100.00'),
      other = await wallet('100.00');
    await bet(w, 'reference-bet', 'reference-bet-key', '20.00');
    await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'reference-win',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Win,
        money: { amount: '5.00', currency: 'BRL' },
      },
      'reference-win-key',
    );
    const mismatchedWallet = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'bad-wallet-refund',
        playerId: other.playerId,
        walletId: other.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'reference-bet',
      },
      'bad-wallet-refund-key',
    );
    const mismatchedRound = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'bad-round-refund',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'another-round',
        gameId: 'game',
        kind: Kind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'reference-bet',
      },
      'bad-round-refund-key',
    );
    const wrongKind = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'bad-kind-refund',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Refund,
        money: { amount: '5.00', currency: 'BRL' },
        referenceExternalTransactionId: 'reference-win',
      },
      'bad-kind-refund-key',
    );
    for (const result of [mismatchedWallet, mismatchedRound, wrongKind]) {
      expect('status' in result && result.status).toBe('REJECTED');
      expect('failureCode' in result && result.failureCode).toBe('REFERENCE_INVALID');
    }
    expect((await service.reconcile(w.id))?.consistent).toBe(true);
    expect((await service.reconcile(other.id))?.consistent).toBe(true);
  });
  test('a missing reference is rejected with an event after the retry limit', async () => {
    const previous = process.env.PENDING_REFERENCE_MAX_ATTEMPTS;
    process.env.PENDING_REFERENCE_MAX_ATTEMPTS = '1';
    try {
      const w = await wallet('25.00');
      await submit(
        {
          providerId: 'integration-provider',
          externalTransactionId: 'reference-exhausted',
          playerId: w.playerId,
          walletId: w.id,
          roundId: 'round',
          gameId: 'game',
          kind: Kind.Rollback,
          money: { amount: '5.00', currency: 'BRL' },
          referenceExternalTransactionId: 'never-arrived',
        },
        'reference-exhausted-key',
      );
      await db.query(
        'UPDATE wager_transactions SET next_attempt_at=now() WHERE idempotency_key=$1',
        [idempotencyKey('reference-exhausted-key')],
      );
      await service.retryPendingReferences();
      const tx = await service.byExternal(
        'integration-provider',
        externalId('reference-exhausted'),
      );
      expect(tx.status).toBe('REJECTED');
      expect(tx.failure_code).toBe('REFERENCE_NOT_FOUND');
      const event = await db.query(
        "SELECT payload FROM outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionRejected' ORDER BY occurred_at DESC LIMIT 1",
        [tx.id],
      );
      expect(event[0]?.payload?.data?.failureCode).toBe('REFERENCE_NOT_FOUND');
      expect((await service.reconcile(w.id))?.consistent).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PENDING_REFERENCE_MAX_ATTEMPTS;
      else process.env.PENDING_REFERENCE_MAX_ATTEMPTS = previous;
    }
  });
  test('a rollback that would overdraft is explicitly rejected without a ledger movement', async () => {
    const w = await wallet('100.00');
    await bet(w, 'bet-for-win', 'bet-for-win-key', '20.00');
    await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'win-to-reverse',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Win,
        money: { amount: '30.00', currency: 'BRL' },
      },
      'win-to-reverse-key',
    );
    await bet(w, 'spend-win', 'spend-win-key', '100.00');
    const result = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'rollback-win',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Rollback,
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win-to-reverse',
      },
      'rollback-win-key',
    );
    expect('failureCode' in result && result.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect((await service.wallet(w.id))?.balance.amount).toBe('10.00');
    const rollback = await service.byExternal('integration-provider', externalId('rollback-win'));
    const ledger = await db.query(
      'SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id=$1',
      [rollback.id],
    );
    expect(ledger[0].count).toBe(0);
  });
  test('loss has no balance effect and replay returns the original observed balance', async () => {
    const w = await wallet('100.00');
    await bet(w, 'stable-result', 'stable-key', '25.00');
    await bet(w, 'later-debit', 'later-key', '10.00');
    const replay = await bet(w, 'stable-result', 'stable-key', '25.00');
    expect('balance' in replay && replay.balance?.amount).toBe('75.00');
    expect('idempotentReplay' in replay && replay.idempotentReplay).toBe(true);
    const before = await service.wallet(w.id);
    await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'loss-no-effect',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Loss,
        money: { amount: '1.00', currency: 'BRL' },
      },
      'loss-no-effect-key',
    );
    expect((await service.wallet(w.id))?.balance.amount).toBe(before?.balance.amount);
    const loss = await service.byExternal('integration-provider', externalId('loss-no-effect'));
    const entries = await db.query(
      'SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id=$1',
      [loss.id],
    );
    expect(entries[0].count).toBe(0);
  });
  test('database rejects ledger edits and balance changes without ledger entries', async () => {
    const w = await wallet('15.00');
    await expect(
      db.query('UPDATE wallet_ledger_entries SET amount=amount+1 WHERE wallet_id=$1', [w.id]),
    ).rejects.toThrow();
    await expect(
      db.query('UPDATE wallets SET balance=balance+1 WHERE id=$1', [w.id]),
    ).rejects.toThrow();
    expect((await service.reconcile(w.id))?.consistent).toBe(true);
  });
  test('reconciliation logs and counts a detected balance mismatch', async () => {
    const w = await wallet('15.00'),
      before = metrics.render();
    await db.query('ALTER TABLE wallets DISABLE TRIGGER wallet_balance_matches_ledger');
    try {
      await db.query('UPDATE wallets SET balance=balance+1 WHERE id=$1', [w.id]);
      const mismatch = await service.reconcile(w.id);
      expect(mismatch?.consistent).toBe(false);
      expect(mismatch?.difference.amount).toBe('1.00');
      expect(metrics.render()).not.toBe(before);
      expect(metrics.render()).toContain('wallet_reconciliation_mismatches_total 1');
    } finally {
      await db.query('UPDATE wallets SET balance=balance-1 WHERE id=$1', [w.id]);
      await db.query('ALTER TABLE wallets ENABLE TRIGGER wallet_balance_matches_ledger');
    }
    expect((await service.reconcile(w.id))?.consistent).toBe(true);
  });
  test('different wallets can process in parallel without cross-wallet locking', async () => {
    const [a, b] = await Promise.all([wallet('50.00'), wallet('70.00')]);
    const results = await Promise.all([
      bet(a, 'parallel-a', 'parallel-a-key', '10.00'),
      bet(b, 'parallel-b', 'parallel-b-key', '20.00'),
    ]);
    expect(results.every((r) => 'status' in r && r.status === 'PROCESSED')).toBe(true);
    expect((await service.wallet(a.id))?.balance.amount).toBe('40.00');
    expect((await service.wallet(b.id))?.balance.amount).toBe('50.00');
  });
  test('refunds and rollbacks reverse the reference exactly once', async () => {
    const w = await wallet('50.00');
    await bet(w, 'reversible-bet', 'reversible-bet-key', '20.00');
    const refund = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'valid-refund',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'reversible-bet',
      },
      'valid-refund-key',
    );
    expect('status' in refund && refund.status).toBe('PROCESSED');
    const duplicate = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'duplicate-refund',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'reversible-bet',
      },
      'duplicate-refund-key',
    );
    expect('failureCode' in duplicate && duplicate.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const rollback = await submit(
      {
        providerId: 'integration-provider',
        externalTransactionId: 'rollback-refund',
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: Kind.Rollback,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'valid-refund',
      },
      'rollback-refund-key',
    );
    expect('status' in rollback && rollback.status).toBe('PROCESSED');
    expect((await service.wallet(w.id))?.balance.amount).toBe('30.00');
    expect((await service.reconcile(w.id))?.consistent).toBe(true);
  });
  test('the same idempotency key with changed business data conflicts', async () => {
    const w = await wallet('30.00');
    await bet(w, 'conflicting-payload', 'conflicting-key', '5.00');
    await expect(bet(w, 'conflicting-payload', 'conflicting-key', '6.00')).rejects.toThrow(
      'Idempotency key was used with a different payload',
    );
    expect((await service.wallet(w.id))?.balance.amount).toBe('25.00');
  });
});
