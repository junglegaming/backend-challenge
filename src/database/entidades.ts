import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

// Tabelas mapeadas no MikroORM. Valores em dinheiro são NUMERIC(20,2)

@Entity({ tableName: 'wallets' })
export class CarteiraEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) playerId!: string;
  @Property({ type: 'string', columnType: 'char(3)' }) currency!: string;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) balance!: string;
  @Property({ type: 'integer' }) version!: number;
  @Property({ type: 'datetime' }) createdAt!: Date;
  @Property({ type: 'datetime' }) updatedAt!: Date;
}

@Entity({ tableName: 'wager_transactions' })
export class TransacaoEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'string' }) providerId!: string;
  @Property({ type: 'string' }) externalTransactionId!: string;
  @Property({ type: 'string' }) idempotencyKey!: string;
  @Property({ type: 'string' }) payloadHash!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'uuid' }) playerId!: string;
  @Property({ type: 'string' }) roundId!: string;
  @Property({ type: 'string' }) gameId!: string;
  @Property({ type: 'string' }) kind!: string;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) amount!: string;
  @Property({ type: 'string', columnType: 'char(3)' }) currency!: string;
  @Property({ type: 'string', nullable: true }) referenceExternalTransactionId?: string | null;
  @Property({ type: 'uuid', nullable: true }) referenceTransactionId?: string | null;
  @Property({ type: 'string' }) status!: string;
  @Property({ type: 'string', nullable: true }) failureCode?: string | null;
  @Property({ type: 'decimal', precision: 20, scale: 2, nullable: true }) balanceAfter?: string | null;
  @Property({ type: 'integer' }) referenceAttempts!: number;
  @Property({ type: 'datetime', nullable: true }) nextReferenceCheckAt?: Date | null;
  @Property({ type: 'string' }) correlationId!: string;
  @Property({ type: 'datetime' }) createdAt!: Date;
  @Property({ type: 'datetime' }) updatedAt!: Date;
  @Property({ type: 'datetime', nullable: true }) processedAt?: Date | null;
}

@Entity({ tableName: 'wallet_ledger_entries' })
export class LancamentoEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'uuid' }) transactionId!: string;
  @Property({ type: 'string' }) direction!: string;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) amount!: string;
  @Property({ type: 'string', columnType: 'char(3)' }) currency!: string;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) balanceBefore!: string;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) balanceAfter!: string;
  @Property({ type: 'integer' }) walletVersion!: number;
  @Property({ type: 'datetime' }) createdAt!: Date;
}

@Entity({ tableName: 'inbox_messages' })
export class MensagemInboxEntity {
  @PrimaryKey({ type: 'string' }) consumerName!: string;
  @PrimaryKey({ type: 'string' }) messageId!: string;
  @Property({ type: 'string' }) payloadHash!: string;
  @Property({ type: 'datetime' }) receivedAt!: Date;
  @Property({ type: 'datetime', nullable: true }) processedAt?: Date | null;
}

@Entity({ tableName: 'outbox_messages' })
export class MensagemOutboxEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'string' }) aggregateId!: string;
  @Property({ type: 'string' }) eventType!: string;
  @Property({ type: 'json' }) payload!: Record<string, unknown>;
  @Property({ type: 'datetime' }) occurredAt!: Date;
  @Property({ type: 'integer' }) attempts!: number;
  @Property({ type: 'datetime' }) nextAttemptAt!: Date;
  @Property({ type: 'datetime', nullable: true }) publishedAt?: Date | null;
}

export const ENTIDADES = [CarteiraEntity, TransacaoEntity, LancamentoEntity, MensagemInboxEntity, MensagemOutboxEntity];
