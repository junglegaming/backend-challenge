import type { Money } from "../../../shared/domain/money";
import { LedgerDirection, oppositeDirection } from "./ledger-direction";
import type { WalletLedgerEntry } from "./wallet-ledger-entry";

/**
 * Double-entry view of every balance movement. The wallet sub-ledger (wallet_ledger_entries) keeps the
 * player-facing running balance; the journal (ledger_postings) records both legs of each movement so the books
 * always balance (Σ debits = Σ credits per transaction — enforced by a deferred constraint trigger).
 *
 * Counterparty accounts are append-only with NO materialised balance: a "house" balance row updated on every
 * bet would be a single hot row shared by all wallets — precisely the global lock the challenge forbids.
 * Their balances are derived on demand (SUM over postings).
 */
export interface LedgerPosting {
  account: string;
  direction: LedgerDirection;
  money: Money;
}

export const walletAccount = (walletId: string) => `wallet:${walletId}`;
export const providerClearingAccount = (providerId: string, currency: string) =>
  `provider:${providerId}:${currency}`;
export const systemFundingAccount = (currency: string) => `system:funding:${currency}`;

export function postingsFor(
  entry: WalletLedgerEntry,
  counterpartyAccount: string,
): [LedgerPosting, LedgerPosting] {
  return [
    { account: walletAccount(entry.walletId), direction: entry.direction, money: entry.money },
    { account: counterpartyAccount, direction: oppositeDirection(entry.direction), money: entry.money },
  ];
}

export function isBalanced(postings: readonly LedgerPosting[]): boolean {
  const first = postings[0];
  if (!first) return true;
  let debits = first.money.subtract(first.money);
  let credits = debits;
  for (const p of postings) {
    if (p.direction === LedgerDirection.Debit) debits = debits.add(p.money);
    else credits = credits.add(p.money);
  }
  return debits.equals(credits);
}
