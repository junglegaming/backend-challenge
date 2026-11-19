import { describe, expect, test } from 'bun:test';
import { FailureCode, InvalidTransactionStateError, ValidationError } from '../../src/domain/errors';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { CreateWagerTransactionProps, WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let n = 0;
const make = (over: Partial<CreateWagerTransactionProps> = {}) => {
  n += 1;
  return WagerTransaction.create({
    id: `id-${n}`, providerId: 'prov', externalTransactionId: `ext-${n}`, idempotencyKey: `prov:ext-${n}`, payloadHash: 'h',
    walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1', kind: Kind.Bet, money: brl('10.00'), createdAt: at, ...over,
  });
};
const processed = (over: Partial<CreateWagerTransactionProps> = {}) => {
  const tx = make(over);
  tx.markProcessed(undefined, at, brl('0.00'));
  return tx;
};

describe('WagerTransaction lifecycle', () => {
  test('is born PENDING', () => {
    expect(make().status).toBe(Status.Pending);
  });

  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => make({ kind: Kind.Refund })).toThrow(ValidationError);
    expect(() => make({ kind: Kind.Rollback })).toThrow(ValidationError);
    expect(make({ kind: Kind.Win }).requiresReference()).toBe(false);
  });

  test('operations that move the balance require a positive amount; LOSS does not', () => {
    expect(() => make({ money: brl('0.00') })).toThrow(ValidationError);
    expect(make({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, at, brl('1.00'))],
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at, brl('1.00'))],
    ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.InternalError, at)],
  ])('%s is terminal: any further transition throws', (_name, finish) => {
    const tx = make();
    finish(tx);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalError, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(at)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE schedules retries with exponential backoff and can still resolve', () => {
    const tx = make({ kind: Kind.Refund, referenceExternalTransactionId: 'missing' });
    tx.markPendingReference(at);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextAttemptAt!.getTime() - at.getTime()).toBe(1000);
    tx.markPendingReference(at);
    tx.markPendingReference(at);
    expect(tx.attempts).toBe(3);
    expect(tx.nextAttemptAt!.getTime() - at.getTime()).toBe(4000);
    tx.markProcessed('ref-id', at, brl('5.00'));
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test('same idempotency key with a different payload hash is not a replay', () => {
    const tx = make();
    expect(tx.matchesPayload('h')).toBe(true);
    expect(tx.matchesPayload('other')).toBe(false);
  });
});

describe('ledger direction per kind', () => {
  test('BET debits; WIN and REFUND credit; LOSS has no entry', () => {
    expect(make().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make({ kind: Kind.Refund, referenceExternalTransactionId: 'x' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make({ kind: Kind.Loss }).ledgerDirectionFor()).toBeUndefined();
  });

  test('ROLLBACK inverts the reference', () => {
    const rollback = make({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(processed())).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Refund, referenceExternalTransactionId: 'y' }))).toBe(LedgerDirection.Debit);
  });
});

describe('reference rules', () => {
  const refund = (over: Partial<CreateWagerTransactionProps> = {}) => make({ kind: Kind.Refund, referenceExternalTransactionId: 'x', ...over });
  const rollback = (over: Partial<CreateWagerTransactionProps> = {}) => make({ kind: Kind.Rollback, referenceExternalTransactionId: 'x', ...over });

  test('a valid reference passes', () => {
    expect(refund().checkReference(processed())).toBeUndefined();
    expect(rollback().checkReference(processed({ kind: Kind.Win }))).toBeUndefined();
  });

  test.each([
    ['provider', { providerId: 'other' }],
    ['player', { playerId: 'other' }],
    ['wallet', { walletId: 'other' }],
    ['round', { roundId: 'other' }],
    ['currency', { money: Money.from({ amount: '10.00', currency: 'USD' }) }],
  ])('reference from another %s is a mismatch', (_name, over) => {
    expect(refund().checkReference(processed(over))).toBe(FailureCode.ReferenceMismatch);
  });

  test('REFUND only references BET; ROLLBACK references BET, WIN or REFUND', () => {
    expect(refund().checkReference(processed({ kind: Kind.Win }))).toBe(FailureCode.InvalidReferenceKind);
    expect(rollback().checkReference(processed({ kind: Kind.Loss }))).toBe(FailureCode.InvalidReferenceKind);
    expect(rollback().checkReference(processed({ kind: Kind.Rollback, referenceExternalTransactionId: 'y' }))).toBe(FailureCode.InvalidReferenceKind);
  });

  test('the reference must be PROCESSED', () => {
    const rejected = make();
    rejected.reject(FailureCode.InsufficientFunds, at, brl('0.00'));
    expect(refund().checkReference(rejected)).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('reversal amount must equal the reference amount; a WIN may differ from its BET', () => {
    expect(refund({ money: brl('9.99') }).checkReference(processed())).toBe(FailureCode.AmountMismatch);
    expect(make({ kind: Kind.Win, money: brl('500.00'), referenceExternalTransactionId: 'x' }).checkReference(processed())).toBeUndefined();
  });
});
