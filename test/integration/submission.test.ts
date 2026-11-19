import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from '../../src/application/errors';
import { OpenWallet } from '../../src/application/open-wallet';
import { ValidationError } from '../../src/domain/errors';
import { freshDatabase, harness, uuid } from '../support';

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

describe('wallet opening', () => {
  test('initial balance creates OPENING transaction, CREDIT entry and events in one SQL transaction', async () => {
    const wallet = await h.wallet('1000.00');
    expect(wallet).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const [tx] = await h.sql(`select kind, status, amount from wager_transactions where wallet_id = ?`, [wallet.id]);
    expect(tx).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' });
    const [entry] = await h.sql(`select direction, balance_before, balance_after from wallet_ledger_entries where wallet_id = ?`, [wallet.id]);
    expect(entry).toMatchObject({ direction: 'CREDIT', balance_before: '0.00', balance_after: '1000.00' });
    const events = await h.sql(`select event_type from outbox_messages where aggregate_id = ? order by sequence`, [wallet.id]);
    expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
  });

  test('zero balance creates no transaction and no ledger entry', async () => {
    const wallet = await h.wallet('0.00');
    expect(await h.sql(`select 1 from wager_transactions where wallet_id = ?`, [wallet.id])).toHaveLength(0);
    expect(await h.sql(`select 1 from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).toHaveLength(0);
  });

  test('a second wallet for the same player and currency is a conflict', async () => {
    const open = new OpenWallet(h.uow);
    const playerId = uuid();
    await open.execute({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }, 'test');
    expect(open.execute({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }, 'test')).rejects.toThrow(WalletAlreadyExistsError);
    // outra moeda é outra wallet
    await open.execute({ playerId, initialBalance: { amount: '1.00', currency: 'USD' } }, 'test');
  });
});

describe('business rules', () => {
  test('BET debits, WIN credits, LOSS only records the result', async () => {
    const wallet = await h.wallet('100.00');
    const bet = await h.send(h.payload(wallet, 'BET', '25.00'));
    expect(bet).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' }, idempotentReplay: false });
    const win = await h.send(h.payload(wallet, 'WIN', '40.00'));
    expect(win.balance.amount).toBe('115.00');
    const loss = await h.send(h.payload(wallet, 'LOSS', '25.00'));
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: { amount: '115.00' } });

    const entries = await h.sql(`select direction, amount from wallet_ledger_entries where wallet_id = ? order by sequence`, [wallet.id]);
    expect(entries.map((e) => `${e.direction} ${e.amount}`)).toEqual(['CREDIT 100.00', 'DEBIT 25.00', 'CREDIT 40.00']);
    const [row] = await h.sql(`select version from wallets where id = ?`, [wallet.id]);
    expect(row!.version).toBe(3); // 1 na abertura + BET + WIN; LOSS não mexe
    const events = await h.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = ?`, [loss.transactionId]);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']); // sem WalletBalanceChanged
  });

  test('BET without funds is REJECTED, leaves no ledger entry and stays auditable', async () => {
    const wallet = await h.wallet('10.00');
    const bet = await h.send(h.payload(wallet, 'BET', '10.01'));
    expect(bet).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await h.sql(`select 1 from wallet_ledger_entries where transaction_id = ?`, [bet.transactionId])).toHaveLength(0);
    const events = await h.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = ?`, [bet.transactionId]);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionRejected']);
  });

  test('REFUND reverts a processed BET exactly once', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '30.00');
    await h.send(bet);
    const refund = await h.send(h.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const again = await h.send(h.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    const rollback = await h.send(h.payload(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect(await h.balance(wallet.id)).toBe('100.00');
  });

  test('ROLLBACK inverts BET (credit), WIN (debit) and REFUND (debit)', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '30.00');
    await h.send(bet);
    const rollbackBet = await h.send(h.payload(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollbackBet.balance.amount).toBe('100.00');

    const win = h.payload(wallet, 'WIN', '50.00');
    await h.send(win);
    const rollbackWin = await h.send(h.payload(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollbackWin.balance.amount).toBe('100.00');

    const bet2 = h.payload(wallet, 'BET', '20.00');
    await h.send(bet2);
    const refund = h.payload(wallet, 'REFUND', '20.00', { referenceExternalTransactionId: bet2.externalTransactionId });
    await h.send(refund);
    const rollbackRefund = await h.send(h.payload(wallet, 'ROLLBACK', '20.00', { referenceExternalTransactionId: refund.externalTransactionId }));
    expect(rollbackRefund).toMatchObject({ status: 'PROCESSED', balance: { amount: '80.00' } });
  });

  test('a reversal that would overdraw is rejected with its own failure code', async () => {
    const wallet = await h.wallet('0.00');
    const win = h.payload(wallet, 'WIN', '50.00');
    await h.send(win);
    await h.send(h.payload(wallet, 'BET', '40.00'));
    const rollback = await h.send(h.payload(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: { amount: '10.00' } });
    expect(await h.balance(wallet.id)).toBe('10.00');
  });

  test('reference validation: amount, kind, round, rejected reference', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '30.00');
    await h.send(bet);
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    expect((await h.send(h.payload(wallet, 'REFUND', '29.99', ref))).failureCode).toBe('AMOUNT_MISMATCH');
    expect((await h.send(h.payload(wallet, 'REFUND', '30.00', { ...ref, roundId: 'other-round' }))).failureCode).toBe('REFERENCE_MISMATCH');

    const win = h.payload(wallet, 'WIN', '5.00');
    await h.send(win);
    expect((await h.send(h.payload(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: win.externalTransactionId }))).failureCode).toBe('INVALID_REFERENCE_KIND');

    const rejectedBet = h.payload(wallet, 'BET', '9999.00');
    await h.send(rejectedBet);
    expect((await h.send(h.payload(wallet, 'REFUND', '9999.00', { referenceExternalTransactionId: rejectedBet.externalTransactionId }))).failureCode).toBe('REFERENCE_NOT_PROCESSED');
    expect(await h.balance(wallet.id)).toBe('75.00');
  });

  test('currency different from the wallet is rejected', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } });
    const result = await h.send(bet);
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: { amount: '100.00', currency: 'BRL' } });
    // o replay devolve o saldo na moeda da wallet, não na moeda (errada) da operação
    expect(await h.send(bet)).toEqual({ ...result, idempotentReplay: true });
  });

  test('a missing reference parks the transaction as PENDING_REFERENCE without touching the balance', async () => {
    const wallet = await h.wallet('100.00');
    const refund = await h.send(h.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: 'not-yet' }));
    expect(refund).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
    const events = await h.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = ?`, [refund.transactionId]);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('idempotency', () => {
  test('an identical request replays the original result, including the balance observed back then', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '25.00');
    const first = await h.send(bet);
    await h.send(h.payload(wallet, 'BET', '50.00')); // saldo atual passa a ser 25.00
    const replay = await h.send(bet);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance.amount).toBe('75.00');
    expect(await h.sql(`select 1 from wallet_ledger_entries where transaction_id = ?`, [first.transactionId])).toHaveLength(1);
  });

  test('a rejected transaction also replays as rejected (no second chance with the same key)', async () => {
    const wallet = await h.wallet('10.00');
    const bet = h.payload(wallet, 'BET', '50.00');
    const first = await h.send(bet);
    await h.send(h.payload(wallet, 'WIN', '100.00'));
    expect(await h.send(bet)).toEqual({ ...first, idempotentReplay: true });
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '25.00');
    await h.send(bet, 'key-1');
    expect(h.send({ ...bet, money: { amount: '26.00', currency: 'BRL' } }, 'key-1')).rejects.toThrow(IdempotencyConflictError);
    // mesmo id externo com outra key também é conflito
    expect(h.send(bet, 'key-2')).rejects.toThrow(IdempotencyConflictError);
    expect(await h.balance(wallet.id)).toBe('75.00');
  });
});

describe('input validation', () => {
  test('rejects OPENING, unknown fields, bad money and missing reference', async () => {
    const wallet = await h.wallet('100.00');
    for (const bad of [
      h.payload(wallet, 'OPENING', '10.00'),
      h.payload(wallet, 'BET', '10.00', { extra: true }),
      h.payload(wallet, 'BET', '10.0'),
      h.payload(wallet, 'BET', '-10.00'),
      h.payload(wallet, 'BET', '0.00'),
      h.payload(wallet, 'BET', '10.00', { money: { amount: 10, currency: 'BRL' } }),
      h.payload(wallet, 'REFUND', '10.00'),
      h.payload(wallet, 'BET', '10.00', { gameId: 'nul\u0000byte' }),
    ]) {
      expect(h.send(bad)).rejects.toThrow(ValidationError);
    }
    expect(h.submit.execute({ idempotencyKey: '', payload: h.payload(wallet, 'BET', '1.00'), correlationId: 't' })).rejects.toThrow(ValidationError);
    expect(await h.balance(wallet.id)).toBe('100.00');
  });

  test('unknown wallet or wallet of another player is not found and persists nothing', async () => {
    const wallet = await h.wallet('100.00');
    const ghost = h.payload(wallet, 'BET', '1.00', { walletId: uuid() });
    expect(h.send(ghost)).rejects.toThrow(WalletNotFoundError);
    const stolen = h.payload(wallet, 'BET', '1.00', { playerId: uuid() });
    expect(h.send(stolen)).rejects.toThrow(WalletNotFoundError);
    expect(await h.sql(`select 1 from wager_transactions where external_transaction_id in (?, ?)`, [ghost.externalTransactionId, stolen.externalTransactionId])).toHaveLength(0);
  });
});
