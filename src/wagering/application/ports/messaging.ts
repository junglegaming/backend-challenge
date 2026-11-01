import { InboxMessage } from "../../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../../messaging/domain/outbox-message";
import { TransactionContext } from "../../../shared/application/unit-of-work";

export abstract class OutboxWriter {
  abstract append(tx: TransactionContext, message: OutboxMessage): Promise<void>;
}

export type InboxClaim = { inserted: true } | { inserted: false; existing: InboxMessage };
export abstract class InboxStore {
  abstract claim(tx: TransactionContext, message: InboxMessage): Promise<InboxClaim>;
  abstract markProcessed(tx: TransactionContext, message: InboxMessage): Promise<void>;
}
