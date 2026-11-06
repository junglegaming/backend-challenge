import { expect } from 'bun:test';
import { Money } from '../../../src/domain/shared/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-enums';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { type ProcessWagerResult, WagerRulesService } from '../../../src/domain/wagering/wager-rules.service';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const t0 = new Date('2026-01-01T00:00:00Z');

let seq = 0;
export const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function tx(
  kind: WagerTransactionKind,
  amount: string,
  over: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  const n = ++seq;
  return WagerTransaction.create({
    id: `tx-${n}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `provider-a:ext-${n}`,
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    createdAt: t0,
    ...over,
  });
}

/** Wallet + the ledger it has produced so far (starting with the OPENING entry). */
export class Scenario {
  readonly rules = new WagerRulesService();
  readonly wallet: Wallet;
  readonly ledger: WalletLedgerEntry[] = [];

  constructor(initial: string) {
    this.wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), now: t0 });
    const opening = this.wallet.openingEntry({ entryId: 'opening', transactionId: 'opening-tx', at: t0 });
    if (opening) this.ledger.push(opening);
  }

  run(
    transaction: WagerTransaction,
    ctx: { reference?: WagerTransaction | undefined; alreadyReversed?: boolean; wallet?: Wallet } = {},
  ): ProcessWagerResult {
    const result = this.rules.process({
      transaction,
      wallet: ctx.wallet ?? this.wallet,
      reference: ctx.reference,
      referenceAlreadyReversed: ctx.alreadyReversed ?? false,
      entryId: nextId('entry'),
      now: t0,
    });
    if (result.status === 'PROCESSED' && result.entry) this.ledger.push(result.entry);
    return result;
  }

  /** Final invariant: wallet.balance == balance rebuilt from the ledger. */
  expectConsistent(): void {
    const rebuilt = this.ledger.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
    expect(this.wallet.balance.toString()).toBe(rebuilt.toString());
    expect(this.wallet.balance.isNegative()).toBe(false);
    for (const e of this.ledger) expect(e.isBalanced()).toBe(true);
  }
}
