import type { IdGenerator } from "../../../shared/domain/ports";
import type { EventContext } from "../../messaging/domain/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { Wallet } from "../../wallet/domain/wallet";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wagering-events";
import type { ProcessWagerOutcome } from "../domain/wager-processor";
import type { WagerTransaction } from "../domain/wager-transaction";

export interface EventMeta {
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

/**
 * Maps a processing outcome to the outbox messages that must commit with it:
 *  PROCESSED → WagerTransactionProcessed (+ WalletBalanceChanged when a ledger entry exists)
 *  REJECTED  → WagerTransactionRejected
 *  PENDING_REFERENCE (first time only) → WagerTransactionPendingReference
 */
export function outboxMessagesFor(
  outcome: ProcessWagerOutcome,
  tx: WagerTransaction,
  wallet: Wallet,
  meta: EventMeta,
  ids: IdGenerator,
): OutboxMessage[] {
  const ctx = (): EventContext => ({ ...meta, eventId: ids.next() });
  switch (outcome.type) {
    case "PROCESSED": {
      const messages = [OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx()))];
      if (outcome.ledgerEntry) {
        messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx())));
      }
      return messages;
    }
    case "REJECTED":
      return [OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx()))];
    case "PENDING_REFERENCE":
      return outcome.firstTime
        ? [OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx()))]
        : [];
  }
}
