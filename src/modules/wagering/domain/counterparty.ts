import { providerClearingAccount, systemFundingAccount } from "../../wallet/domain/double-entry";
import type { WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind } from "./wager-transaction-kind";

/** The other leg of a wallet movement: system funding for OPENING, the provider's clearing account otherwise. */
export function counterpartyAccountFor(tx: WagerTransaction): string {
  return tx.kind === WagerTransactionKind.Opening
    ? systemFundingAccount(tx.money.currency)
    : providerClearingAccount(tx.providerId, tx.money.currency);
}
