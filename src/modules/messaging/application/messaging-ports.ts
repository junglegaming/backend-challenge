import type { InboxMessage } from "../domain/inbox-message";
import type { OutboxMessage } from "../domain/outbox-message";

export interface InboxRepository {
  /**
   * Multi-row INSERT … ON CONFLICT DO NOTHING (processed_at included). Returns the messageIds actually inserted;
   * the others already exist (redeliveries). A concurrent transaction holding the same key makes this block.
   */
  tryInsertMany(messages: readonly InboxMessage[]): Promise<Set<string>>;
  findMany(consumerName: string, messageIds: readonly string[]): Promise<InboxMessage[]>;
  /** Removes records of items refused inside a batch (same transaction), so a redelivery is evaluated again. */
  deleteMany(consumerName: string, messageIds: readonly string[]): Promise<void>;
  purgeReceivedBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingOccurredAt: Date | undefined;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /** Leases up to `limit` due messages (FOR UPDATE SKIP LOCKED); expired leases are reclaimable. */
  claimDue(now: Date, limit: number, leaseUntil: Date, owner: string): Promise<OutboxMessage[]>;
  markPublished(ids: readonly string[], at: Date): Promise<void>;
  scheduleRetry(message: OutboxMessage): Promise<void>;
  releaseLeases(owner: string): Promise<number>;
  stats(): Promise<OutboxStats>;
}
