import { expect } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import {
  CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  WagerTransaction,
} from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wagering/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/wagering/domain/wallet-ledger-entry";

export const now = new Date("2026-10-31T12:00:00.000Z");
export const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";
export const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });
export function open(amount = "100.00") {
  const result = Wallet.open({
    id: walletId,
    playerId: "player-1",
    initialBalance: money(amount),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    at: now,
  });
  return { wallet: result.wallet, entries: result.ledgerEntry ? [result.ledgerEntry] : [] };
}
export function transaction(overrides: Partial<CreateWagerTransactionProps> = {}) {
  const id = crypto.randomUUID();
  return WagerTransaction.create({
    id,
    providerId: "provider-a",
    externalTransactionId: id,
    idempotencyKey: id,
    payloadHash: "a".repeat(64),
    walletId,
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: money("10.00"),
    createdAt: now,
    ...overrides,
  });
}
export function assertUnitLedgerInvariant(wallet: Wallet, entries: WalletLedgerEntry[]) {
  let rebuilt = Money.zero(wallet.currency);
  for (const entry of entries) {
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceBefore.equals(rebuilt)).toBe(true);
    rebuilt =
      entry.direction === LedgerDirection.Credit
        ? rebuilt.add(entry.money)
        : rebuilt.subtract(entry.money);
    expect(entry.balanceAfter.equals(rebuilt)).toBe(true);
  }
  expect(wallet.balance.equals(rebuilt)).toBe(true);
}
