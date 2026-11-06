import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../../src/domain/wagering/wager-enums';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../../src/domain/wagering/wagering.errors';
import { Scenario, brl, t0, tx } from './support';

/** Processes a BET/WIN etc. and returns it, asserting it was applied. */
function processed(s: Scenario, kind: K, amount: string, over: Parameters<typeof tx>[2] = {}) {
  const t = tx(kind, amount, over);
  expect(s.run(t).status).toBe(S.Processed);
  return t;
}

describe('BET', () => {
  test('debits the wallet and produces one DEBIT entry', () => {
    const s = new Scenario('100.00');
    const bet = tx(K.Bet, '25.00');
    const result = s.run(bet);

    expect(result.status).toBe(S.Processed);
    expect(bet.status).toBe(S.Processed);
    expect(bet.processedAt).toEqual(t0);
    expect(s.wallet.balance.toString()).toBe('75.00');
    const debits = s.ledger.filter((e) => e.direction === LedgerDirection.Debit);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.transactionId).toBe(bet.id);
    s.expectConsistent();
  });

  test('insufficient funds → REJECTED, no ledger entry, wallet untouched', () => {
    const s = new Scenario('100.00');
    const bet = tx(K.Bet, '100.01');
    const result = s.run(bet);

    expect(result).toEqual({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(S.Rejected);
    expect(s.wallet.balance.toString()).toBe('100.00');
    expect(s.wallet.version).toBe(1);
    expect(s.ledger).toHaveLength(1); // only OPENING
    s.expectConsistent();
  });

  test('mandatory scenario: two bets of 80.00 over 100.00 → one PROCESSED, one REJECTED, 20.00 left, one debit', () => {
    const s = new Scenario('100.00');
    const first = tx(K.Bet, '80.00');
    const second = tx(K.Bet, '80.00');
    s.run(first);
    s.run(second);

    expect([first.status, second.status].sort()).toEqual([S.Processed, S.Rejected]);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(s.wallet.balance.toString()).toBe('20.00');
    expect(s.ledger.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
    s.expectConsistent();
  });

  test('betting the exact balance is allowed', () => {
    const s = new Scenario('50.00');
    expect(s.run(tx(K.Bet, '50.00')).status).toBe(S.Processed);
    expect(s.wallet.balance.isZero()).toBe(true);
    s.expectConsistent();
  });
});

describe('WIN', () => {
  test('credits the wallet with one CREDIT entry', () => {
    const s = new Scenario('100.00');
    processed(s, K.Bet, '10.00');
    const win = processed(s, K.Win, '40.00');
    expect(s.wallet.balance.toString()).toBe('130.00');
    expect(s.ledger.at(-1)!.direction).toBe(LedgerDirection.Credit);
    expect(s.ledger.at(-1)!.transactionId).toBe(win.id);
    s.expectConsistent();
  });

  test('a WIN may carry an informational reference to the BET (not resolved or enforced)', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '10.00');
    const win = tx(K.Win, '20.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(win).status).toBe(S.Processed);
    s.expectConsistent();
  });
});

describe('LOSS', () => {
  test('is PROCESSED without balance change, version change or ledger entry', () => {
    const s = new Scenario('100.00');
    const loss = tx(K.Loss, '10.00');
    const result = s.run(loss);

    expect(result).toEqual({ status: S.Processed, entry: undefined });
    expect(loss.status).toBe(S.Processed);
    expect(s.wallet.balance.toString()).toBe('100.00');
    expect(s.wallet.version).toBe(1);
    expect(s.ledger).toHaveLength(1);
    s.expectConsistent();
  });
});

describe('REFUND', () => {
  test('reverts a PROCESSED BET: credit, same amount, reference recorded', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '30.00');
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });

    expect(s.run(refund, { reference: bet }).status).toBe(S.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(s.wallet.balance.toString()).toBe('100.00');
    expect(s.ledger.at(-1)!.direction).toBe(LedgerDirection.Credit);
    s.expectConsistent();
  });

  test('missing reference → PENDING_REFERENCE, no money moves', () => {
    const s = new Scenario('100.00');
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: 'not-yet' });
    expect(s.run(refund, { reference: undefined })).toEqual({ status: S.PendingReference });
    expect(refund.status).toBe(S.PendingReference);
    expect(s.wallet.balance.toString()).toBe('100.00');
    expect(s.wallet.version).toBe(1);
    s.expectConsistent();
  });

  test('out-of-order: reprocessing a PENDING_REFERENCE once the BET exists applies it', () => {
    const s = new Scenario('100.00');
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: 'bet-ext' });
    s.run(refund);
    expect(refund.status).toBe(S.PendingReference);

    const bet = processed(s, K.Bet, '30.00', { externalTransactionId: 'bet-ext' });
    expect(s.run(refund, { reference: bet }).status).toBe(S.Processed);
    expect(s.wallet.balance.toString()).toBe('100.00');
    s.expectConsistent();
  });

  test('exhausted retries: reject with REFERENCE_NOT_FOUND', () => {
    const s = new Scenario('100.00');
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: 'never' });
    s.run(refund);
    refund.reject(FailureCode.ReferenceNotFound);
    expect(refund.status).toBe(S.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    s.expectConsistent();
  });

  test.each([K.Win, K.Loss, K.Refund])('only BET is refundable: reference %s → INVALID_REFERENCE_KIND', (kind) => {
    const s = new Scenario('100.00');
    const extra = kind === K.Refund ? { referenceExternalTransactionId: 'whatever' } : {};
    const reference = tx(kind, '10.00', extra);
    reference.markProcessed(undefined, t0);
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: reference.externalTransactionId });

    expect(s.run(refund, { reference })).toEqual({ status: S.Rejected, failureCode: FailureCode.InvalidReferenceKind });
    s.expectConsistent();
  });

  test('amount different from the reference → AMOUNT_MISMATCH (both directions)', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '30.00');
    for (const amount of ['29.99', '30.01', '10.00']) {
      const refund = tx(K.Refund, amount, { referenceExternalTransactionId: bet.externalTransactionId });
      expect(s.run(refund, { reference: bet })).toEqual({ status: S.Rejected, failureCode: FailureCode.AmountMismatch });
    }
    expect(s.wallet.balance.toString()).toBe('70.00');
    s.expectConsistent();
  });

  test('already reversed → ALREADY_REVERSED (no second credit)', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '30.00');
    const second = tx(K.Refund, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(second, { reference: bet, alreadyReversed: true })).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.AlreadyReversed,
    });
    expect(s.wallet.balance.toString()).toBe('70.00');
    s.expectConsistent();
  });

  test('a REJECTED reference cannot be refunded → REFERENCE_NOT_PROCESSED', () => {
    const s = new Scenario('10.00');
    const bet = tx(K.Bet, '50.00');
    s.run(bet);
    expect(bet.status).toBe(S.Rejected);
    const refund = tx(K.Refund, '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(refund, { reference: bet })).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(s.wallet.balance.toString()).toBe('10.00');
    s.expectConsistent();
  });

  test('a FAILED reference → REFERENCE_NOT_PROCESSED', () => {
    const s = new Scenario('10.00');
    const bet = tx(K.Bet, '5.00');
    bet.fail(FailureCode.InternalError);
    const refund = tx(K.Refund, '5.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(refund, { reference: bet })).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    s.expectConsistent();
  });

  test('a reference that is itself still pending makes the reversal wait', () => {
    const s = new Scenario('100.00');
    const bet = tx(K.Bet, '30.00'); // known but not applied yet
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(refund, { reference: bet })).toEqual({ status: S.PendingReference });
    expect(s.wallet.balance.toString()).toBe('100.00');
    s.expectConsistent();
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits back (inverse of the debit)', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '30.00');
    const rb = tx(K.Rollback, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(rb, { reference: bet }).status).toBe(S.Processed);
    expect(s.ledger.at(-1)!.direction).toBe(LedgerDirection.Credit);
    expect(s.wallet.balance.toString()).toBe('100.00');
    s.expectConsistent();
  });

  test('of a WIN debits (inverse of the credit)', () => {
    const s = new Scenario('100.00');
    const win = processed(s, K.Win, '40.00');
    const rb = tx(K.Rollback, '40.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(s.run(rb, { reference: win }).status).toBe(S.Processed);
    expect(s.ledger.at(-1)!.direction).toBe(LedgerDirection.Debit);
    expect(s.wallet.balance.toString()).toBe('100.00');
    s.expectConsistent();
  });

  test('of a REFUND debits', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '30.00');
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    s.run(refund, { reference: bet });
    const rb = tx(K.Rollback, '30.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(s.run(rb, { reference: refund }).status).toBe(S.Processed);
    expect(s.wallet.balance.toString()).toBe('70.00');
    s.expectConsistent();
  });

  test('reversal that would make the balance negative → REVERSAL_WOULD_OVERDRAW (distinct from bet without funds)', () => {
    const s = new Scenario('0.00');
    const win = processed(s, K.Win, '100.00');
    processed(s, K.Bet, '90.00'); // player spent the winnings
    const rb = tx(K.Rollback, '100.00', { referenceExternalTransactionId: win.externalTransactionId });

    const result = s.run(rb, { reference: win });
    expect(result).toEqual({ status: S.Rejected, failureCode: FailureCode.ReversalWouldOverdraw });
    expect(rb.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(s.wallet.balance.toString()).toBe('10.00');
    s.expectConsistent();
  });

  test.each([K.Loss, K.Rollback])('cannot revert a %s → INVALID_REFERENCE_KIND', (kind) => {
    const s = new Scenario('100.00');
    const extra = kind === K.Rollback ? { referenceExternalTransactionId: 'x' } : {};
    const reference = tx(kind, '10.00', extra);
    reference.markProcessed(undefined, t0);
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: reference.externalTransactionId });
    expect(s.run(rb, { reference })).toEqual({ status: S.Rejected, failureCode: FailureCode.InvalidReferenceKind });
    s.expectConsistent();
  });

  test('missing reference → PENDING_REFERENCE', () => {
    const s = new Scenario('100.00');
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: 'later' });
    expect(s.run(rb)).toEqual({ status: S.PendingReference });
    s.expectConsistent();
  });

  test('duplicate reversal and amount mismatch are rejected', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '30.00');
    const dup = tx(K.Rollback, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(dup, { reference: bet, alreadyReversed: true })).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.AlreadyReversed,
    });
    const wrong = tx(K.Rollback, '31.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(s.run(wrong, { reference: bet })).toEqual({ status: S.Rejected, failureCode: FailureCode.AmountMismatch });
    s.expectConsistent();
  });
});

describe('reference consistency (provider, player, wallet, currency, round)', () => {
  const mismatches: Array<[string, Parameters<typeof tx>[2]]> = [
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'p2' }],
    ['wallet', { walletId: 'w2' }],
    ['round', { roundId: 'round-2' }],
    ['currency', { money: Money.from({ amount: '30.00', currency: 'USD' }) }],
  ];

  test.each(mismatches)('reference from another %s → REFERENCE_MISMATCH', (_name, over) => {
    const s = new Scenario('100.00');
    const foreignBet = tx(K.Bet, '30.00', over);
    foreignBet.markProcessed(undefined, t0);
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: foreignBet.externalTransactionId });

    expect(s.run(refund, { reference: foreignBet })).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
    expect(s.wallet.balance.toString()).toBe('100.00');
    s.expectConsistent();
  });
});

describe('wallet / transaction consistency', () => {
  test('currency different from the wallet → CURRENCY_MISMATCH (committable rejection)', () => {
    const s = new Scenario('100.00');
    const usdBet = tx(K.Bet, '10.00', { money: Money.from({ amount: '10.00', currency: 'USD' }) });
    expect(s.run(usdBet)).toEqual({ status: S.Rejected, failureCode: FailureCode.CurrencyMismatch });
    expect(s.wallet.version).toBe(1);
    s.expectConsistent();
  });

  test('playerId that does not own the wallet → WALLET_PLAYER_MISMATCH', () => {
    const s = new Scenario('100.00');
    const bet = tx(K.Bet, '10.00', { playerId: 'intruder' });
    expect(s.run(bet)).toEqual({ status: S.Rejected, failureCode: FailureCode.WalletPlayerMismatch });
    s.expectConsistent();
  });

  test('a transaction for another wallet id is a programming error', () => {
    const s = new Scenario('100.00');
    const other = Wallet.open({ id: 'w-other', playerId: 'p1', initialBalance: brl('1.00'), now: t0 });
    expect(() => s.run(tx(K.Bet, '1.00'), { wallet: other })).toThrow(InvalidTransactionError);
  });

  test('OPENING is not processed by the rules service', () => {
    const s = new Scenario('100.00');
    const opening = tx(K.Bet, '1.00');
    Object.defineProperty(opening, 'kind', { value: K.Opening });
    expect(() => s.run(opening)).toThrow(InvalidTransactionError);
  });

  test('terminal transactions are never reprocessed (no double effect)', () => {
    const s = new Scenario('100.00');
    const bet = processed(s, K.Bet, '10.00');
    expect(() => s.run(bet)).toThrow(InvalidTransactionStateError);
    expect(s.wallet.balance.toString()).toBe('90.00');
    expect(s.ledger.filter((e) => e.transactionId === bet.id)).toHaveLength(1);
    s.expectConsistent();
  });
});

describe('full round', () => {
  test('BET → WIN → ROLLBACK(WIN) → BET → LOSS keeps wallet == ledger', () => {
    const s = new Scenario('100.00');
    processed(s, K.Bet, '20.00');
    const win = processed(s, K.Win, '50.00');
    const rb = tx(K.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    s.run(rb, { reference: win });
    processed(s, K.Bet, '10.00');
    processed(s, K.Loss, '10.00');

    expect(s.wallet.balance.toString()).toBe('70.00');
    expect(s.wallet.version).toBe(1 + 4);
    s.expectConsistent();
  });
});
