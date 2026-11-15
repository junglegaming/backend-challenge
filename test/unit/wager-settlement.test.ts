import { beforeEach, describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidValueError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerSettlement } from '../../src/domain/wager-settlement';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const now = new Date('2026-01-01T00:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
let seq = 0;

const tx = (kind: Kind, amount: string, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({
    id: `tx-${++seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game',
    kind,
    money: brl(amount),
    createdAt: now,
    ...overrides,
  });

const settlement = new WagerSettlement();
let wallet: Wallet;

const settle = (transaction: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) =>
  settlement.settle({ wallet, transaction, reference, referenceAlreadyReversed, ledgerEntryId: `entry-${++seq}`, now });

/** A BET that went through settlement (PROCESSED) and moved the wallet. */
const processedBet = (amount = '10.00') => {
  const bet = tx(Kind.Bet, amount);
  settle(bet);
  expect(bet.status).toBe(Status.Processed);
  return bet;
};

beforeEach(() => {
  wallet = Wallet.rehydrate({ id: 'w1', playerId: 'p1', currency: 'BRL', balance: brl('100.00'), version: 1, createdAt: now, updatedAt: now });
});

describe('BET', () => {
  test('debits the wallet and produces one DEBIT entry', () => {
    const bet = tx(Kind.Bet, '25.00');
    const decision = settle(bet);
    expect(decision.type).toBe('processed');
    expect(decision.type === 'processed' && decision.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.formatAmount()).toBe('75.00');
    expect(bet.resultBalance?.formatAmount()).toBe('75.00');
  });

  test('is rejected with INSUFFICIENT_FUNDS, without touching the wallet', () => {
    const bet = tx(Kind.Bet, '100.01');
    expect(settle(bet)).toEqual({ type: 'rejected', failureCode: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(Status.Rejected);
    expect(wallet.balance.formatAmount()).toBe('100.00');
    expect(wallet.uncommittedEntries).toHaveLength(0);
  });

  test('currency conflict is rejected', () => {
    const bet = tx(Kind.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(settle(bet)).toEqual({ type: 'rejected', failureCode: FailureCode.CurrencyMismatch });
    expect(wallet.uncommittedEntries).toHaveLength(0);
  });

  test('a player not owning the wallet is rejected', () => {
    expect(settle(tx(Kind.Bet, '1.00', { playerId: 'someone-else' }))).toEqual({
      type: 'rejected',
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });

  test('cannot reference other transactions', () => {
    expect(() => tx(Kind.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidValueError);
  });
});

describe('WIN', () => {
  test('credits the wallet', () => {
    const decision = settle(tx(Kind.Win, '50.00'));
    expect(decision.type === 'processed' && decision.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.formatAmount()).toBe('150.00');
  });

  test('may reference the BET of the same round', () => {
    const bet = processedBet();
    const win = tx(Kind.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    settle(win, bet);
    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });
});

describe('LOSS', () => {
  test('is processed without moving balance nor creating a ledger entry', () => {
    const loss = tx(Kind.Loss, '10.00');
    expect(settle(loss)).toEqual({ type: 'processed', entry: undefined });
    expect(loss.status).toBe(Status.Processed);
    expect(loss.affectsBalance()).toBe(false);
    expect(wallet.balance.formatAmount()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('requires a reference', () => {
    expect(() => tx(Kind.Refund, '10.00')).toThrow(InvalidValueError);
  });

  test('credits back a processed BET', () => {
    const bet = processedBet('10.00');
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const decision = settle(refund, bet);
    expect(decision.type === 'processed' && decision.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.formatAmount()).toBe('100.00');
  });

  test('only references BET', () => {
    const win = tx(Kind.Win, '10.00');
    settle(win);
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(refund, win)).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceKindNotAllowed });
  });

  test('amount must equal the reference (no partial reversal)', () => {
    const bet = processedBet('10.00');
    const refund = tx(Kind.Refund, '5.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, bet)).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceAmountMismatch });
  });

  test('cannot revert twice', () => {
    const bet = processedBet('10.00');
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, bet, true)).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceAlreadyReversed });
  });

  test('reference must belong to the same player, wallet, currency and round', () => {
    const bet = processedBet('10.00');
    const otherRound = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId, roundId: 'round-2' });
    expect(settle(otherRound, bet)).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceMismatch });
  });

  test('a missing or not-yet-applied reference waits (no mutation)', () => {
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: 'not-arrived' });
    expect(settle(refund, undefined)).toEqual({ type: 'awaiting-reference' });
    expect(refund.status).toBe(Status.Pending);

    const pendingBet = tx(Kind.Bet, '10.00');
    expect(settle(tx(Kind.Refund, '10.00', { referenceExternalTransactionId: pendingBet.externalTransactionId }), pendingBet)).toEqual({
      type: 'awaiting-reference',
    });
  });

  test('a REJECTED reference cannot be reverted', () => {
    const bet = tx(Kind.Bet, '1000.00');
    settle(bet);
    expect(bet.status).toBe(Status.Rejected);
    const refund = tx(Kind.Refund, '1000.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, bet)).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits', () => {
    const bet = processedBet('10.00');
    const rollback = tx(Kind.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const decision = settle(rollback, bet);
    expect(decision.type === 'processed' && decision.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.formatAmount()).toBe('100.00');
  });

  test('of a WIN debits', () => {
    const win = tx(Kind.Win, '40.00');
    settle(win);
    const rollback = tx(Kind.Rollback, '40.00', { referenceExternalTransactionId: win.externalTransactionId });
    const decision = settle(rollback, win);
    expect(decision.type === 'processed' && decision.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.formatAmount()).toBe('100.00');
  });

  test('of a REFUND debits', () => {
    const bet = processedBet('10.00');
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    settle(refund, bet);
    const rollback = tx(Kind.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId });
    const decision = settle(rollback, refund);
    expect(decision.type === 'processed' && decision.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.formatAmount()).toBe('90.00');
  });

  test('cannot target LOSS', () => {
    const loss = tx(Kind.Loss, '10.00');
    settle(loss);
    const rollback = tx(Kind.Rollback, '10.00', { referenceExternalTransactionId: loss.externalTransactionId });
    expect(settle(rollback, loss)).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceKindNotAllowed });
  });

  test('that would make the balance negative is rejected with a distinct code', () => {
    const win = tx(Kind.Win, '50.00');
    settle(win);
    settle(tx(Kind.Bet, '140.00')); // balance 150 -> 10
    const rollback = tx(Kind.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(rollback, win)).toEqual({ type: 'rejected', failureCode: FailureCode.ReversalInsufficientFunds });
    expect(rollback.status).toBe(Status.Rejected);
    expect(wallet.balance.formatAmount()).toBe('10.00');
  });
});

describe('WagerTransaction state machine', () => {
  test('terminal states cannot transition', () => {
    const bet = processedBet();
    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.InsufficientFunds, now, brl('0.00'))).toThrow(InvalidTransactionStateError);
    expect(() => bet.markProcessed(undefined, now, brl('0.00'))).toThrow(InvalidTransactionStateError);
    expect(() => bet.fail(FailureCode.ProcessingError, now)).toThrow(InvalidTransactionStateError);
    expect(() => bet.markPendingReference(now, now, brl('0.00'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE counts retries and can still finish', () => {
    const refund = tx(Kind.Refund, '1.00', { referenceExternalTransactionId: 'later' });
    refund.markPendingReference(now, now, brl('100.00'));
    expect(refund.referenceAttempts).toBe(0);
    refund.markPendingReference(now, now, brl('100.00'));
    expect(refund.referenceAttempts).toBe(1);
    refund.reject(FailureCode.ReferenceNotFound, now, brl('100.00'));
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.nextReferenceCheckAt).toBeUndefined();
  });

  test('OPENING is internal only', () => {
    expect(() => tx(Kind.Opening, '1.00')).toThrow(InvalidValueError);
  });

  test('same idempotency key with a different payload hash is not a replay', () => {
    const bet = tx(Kind.Bet, '1.00', { payloadHash: 'b'.repeat(64) });
    expect(bet.matchesPayload('b'.repeat(64))).toBe(true);
    expect(bet.matchesPayload('c'.repeat(64))).toBe(false);
  });
});
