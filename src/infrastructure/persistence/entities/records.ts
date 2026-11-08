/**
 * Persistence records: plain data shapes mirroring the tables.
 * Monetary columns are decimal strings (see MoneyAmountType); the currency sits in its own char(3) column.
 * Mappers (record <-> domain) combine both into `Money`.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WageringTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  balanceSnapshot?: string | null;
  createdAt!: Date;
  processedAt?: Date | null;
  referenceRetryCount!: number;
  referenceNextAttemptAt!: Date;
  correlationId?: string | null;
  causationId?: string | null;
  traceContext?: Record<string, unknown> | null;
}

export class WalletLedgerEntryRecord {
  id!: string;
  seq?: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
  traceContext?: Record<string, unknown> | null;
}
