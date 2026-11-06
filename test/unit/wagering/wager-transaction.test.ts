import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { FailureAdvice, FailureCode, failureAdvice, isBusinessFailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../../src/domain/wagering/wager-enums';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../../src/domain/wagering/wagering.errors';
import { brl, t0, tx } from './support';

describe('WagerTransaction creation', () => {
  test('is born PENDING with a computed payload hash', () => {
    const t = tx(K.Bet, '25.00');
    expect(t.status).toBe(S.Pending);
    expect(t.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.isTerminal()).toBe(false);
    expect(t.failureCode).toBeUndefined();
    expect(t.processedAt).toBeUndefined();
  });

  test('OPENING cannot be submitted', () => {
    expect(() => tx(K.Opening, '10.00')).toThrow(InvalidTransactionError);
  });

  test('unknown kinds are rejected', () => {
    expect(() => tx('TIP' as K, '10.00')).toThrow(InvalidTransactionError);
  });

  test('createOpening is the only way to build an OPENING (internal)', () => {
    const t = WagerTransaction.createOpening({
      id: 'o1',
      providerId: 'internal',
      externalTransactionId: 'opening:w1',
      idempotencyKey: 'opening:w1',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'opening',
      gameId: 'opening',
      money: brl('1000.00'),
      createdAt: t0,
    });
    expect(t.kind).toBe(K.Opening);
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'])(
    'requires %s',
    (field) => {
      expect(() => tx(K.Bet, '1.00', { [field]: '  ' })).toThrow(InvalidTransactionError);
    },
  );

  test('amount must be positive (LOSS may be zero, never negative)', () => {
    expect(() => tx(K.Bet, '0.00')).toThrow(InvalidTransactionError);
    expect(() => tx(K.Win, '0.00')).toThrow(InvalidTransactionError);
    expect(tx(K.Loss, '0.00').affectsBalance()).toBe(false);
    expect(() => tx(K.Loss, '1.00', { money: Money.fromSigned({ amount: '-1.00', currency: 'BRL' }) })).toThrow(
      InvalidTransactionError,
    );
  });

  test('REFUND and ROLLBACK require a reference; BET cannot carry one', () => {
    expect(() => tx(K.Refund, '1.00')).toThrow(InvalidTransactionError);
    expect(() => tx(K.Rollback, '1.00', { referenceExternalTransactionId: '' })).toThrow(InvalidTransactionError);
    expect(() => tx(K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidTransactionError);
    expect(tx(K.Refund, '1.00', { referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
    expect(tx(K.Win, '1.00', { referenceExternalTransactionId: 'x' }).requiresReference()).toBe(false);
  });

  test('a transaction cannot reference itself', () => {
    expect(() =>
      tx(K.Refund, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction queries', () => {
  test('affectsBalance is false only for LOSS', () => {
    expect(tx(K.Bet, '1.00').affectsBalance()).toBe(true);
    expect(tx(K.Win, '1.00').affectsBalance()).toBe(true);
    expect(tx(K.Loss, '1.00').affectsBalance()).toBe(false);
    expect(tx(K.Refund, '1.00', { referenceExternalTransactionId: 'r' }).affectsBalance()).toBe(true);
  });

  test('ledger direction: BET debits; WIN/REFUND credit; LOSS has none', () => {
    expect(tx(K.Bet, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(K.Win, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(K.Refund, '1.00', { referenceExternalTransactionId: 'r' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => tx(K.Loss, '1.00').ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test('ROLLBACK direction is the inverse of its reference', () => {
    const rollback = tx(K.Rollback, '1.00', { referenceExternalTransactionId: 'r' });
    expect(rollback.ledgerDirectionFor(tx(K.Bet, '1.00'))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(tx(K.Win, '1.00'))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(tx(K.Refund, '1.00', { referenceExternalTransactionId: 'b' }))).toBe(
      LedgerDirection.Debit,
    );
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction state machine', () => {
  test('PENDING → PROCESSED records reference and processedAt', () => {
    const t = tx(K.Refund, '1.00', { referenceExternalTransactionId: 'r' });
    t.markProcessed('internal-ref', t0);
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('internal-ref');
    expect(t.processedAt).toEqual(t0);
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE (and stays on retry) → PROCESSED', () => {
    const t = tx(K.Refund, '1.00', { referenceExternalTransactionId: 'r' });
    t.markPendingReference();
    expect(t.status).toBe(S.PendingReference);
    expect(t.isTerminal()).toBe(false);
    t.markPendingReference();
    expect(t.status).toBe(S.PendingReference);
    t.markProcessed('ref', t0);
    expect(t.status).toBe(S.Processed);
  });

  test('PENDING_REFERENCE → REJECTED with REFERENCE_NOT_FOUND', () => {
    const t = tx(K.Rollback, '1.00', { referenceExternalTransactionId: 'r' });
    t.markPendingReference();
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('PENDING → FAILED with an infrastructure code', () => {
    const t = tx(K.Bet, '1.00');
    t.fail(FailureCode.InternalError);
    expect(t.status).toBe(S.Failed);
    expect(t.failureCode).toBe(FailureCode.InternalError);
  });

  const terminals: Array<[string, () => WagerTransaction]> = [
    [
      'PROCESSED',
      () => {
        const t = tx(K.Bet, '1.00');
        t.markProcessed(undefined, t0);
        return t;
      },
    ],
    [
      'REJECTED',
      () => {
        const t = tx(K.Bet, '1.00');
        t.reject(FailureCode.InsufficientFunds);
        return t;
      },
    ],
    [
      'FAILED',
      () => {
        const t = tx(K.Bet, '1.00');
        t.fail(FailureCode.InternalError);
        return t;
      },
    ],
  ];

  test.each(terminals)('%s is terminal: no transition is allowed', (_name, make) => {
    const t = make();
    const before = { status: t.status, code: t.failureCode, processedAt: t.processedAt };
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, t0)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
    expect({ status: t.status, code: t.failureCode, processedAt: t.processedAt }).toEqual(before);
  });

  test('reject() only takes business codes and fail() only infrastructure codes', () => {
    expect(() => tx(K.Bet, '1.00').reject(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
    expect(() => tx(K.Bet, '1.00').fail(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate restores terminal state without re-validating', () => {
    const t = WagerTransaction.rehydrate({
      id: 'x',
      providerId: 'p',
      externalTransactionId: 'e',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r',
      gameId: 'g',
      kind: K.Bet,
      money: brl('1.00'),
      createdAt: t0,
      status: S.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(t.status).toBe(S.Rejected);
    expect(t.isTerminal()).toBe(true);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(t.matchesPayload('h')).toBe(true);
  });
});

describe('FailureCode taxonomy', () => {
  test('every code is classified and has advice', () => {
    for (const code of Object.values(FailureCode)) {
      expect(typeof isBusinessFailureCode(code)).toBe('boolean');
      expect(Object.values(FailureAdvice)).toContain(failureAdvice(code));
    }
  });

  test('infrastructure codes are not business codes', () => {
    expect(isBusinessFailureCode(FailureCode.InternalError)).toBe(false);
    expect(isBusinessFailureCode(FailureCode.RetriesExhausted)).toBe(false);
    expect(isBusinessFailureCode(FailureCode.InsufficientFunds)).toBe(true);
  });

  test('bet without funds and reversal that overdraws are distinct codes', () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalWouldOverdraw);
  });

  test('advice guides the provider', () => {
    expect(failureAdvice(FailureCode.AmountMismatch)).toBe(FailureAdvice.CorrectAndResubmit);
    expect(failureAdvice(FailureCode.InsufficientFunds)).toBe(FailureAdvice.ResubmitLater);
    expect(failureAdvice(FailureCode.AlreadyReversed)).toBe(FailureAdvice.Abandon);
  });
});
