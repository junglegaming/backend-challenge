import { LockMode } from '@mikro-orm/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { UniqueViolationError } from '../../application/errors';
import { TxStore, UnitOfWork } from '../../application/ports';
import { config } from '../../config';
import { FailureCode, ValidationError } from '../../domain/errors';
import { IntegrationEvent } from '../../domain/events';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import { InboxMessage, OutboxMessage } from '../../domain/messaging';
import { Money } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { metrics } from '../../observability/metrics';
import { LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './records';

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

/** SQLSTATE do erro original do driver, preservado pelo MikroORM. */
export const sqlState = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

// lock_not_available (lock_timeout), deadlock_detected
const LOCK_CONFLICTS = new Set(['55P03', '40P01']);

@Injectable()
export class MikroUnitOfWork extends UnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  async run<T>(fn: (store: TxStore) => Promise<T>): Promise<T> {
    try {
      // fork(): um EntityManager (Identity Map + Unit of Work) por transação, nunca compartilhado.
      return await this.orm.em.fork().transactional(async (em) => {
        // Espera por lock tem teto: uma hot wallet travada vira erro transitório, não uma conexão presa.
        await em.execute(`set local lock_timeout = '${config.lockTimeoutMs}ms'`);
        return fn(new MikroTxStore(em));
      });
    } catch (error) {
      const state = sqlState(error);
      if (state && LOCK_CONFLICTS.has(state)) metrics.lockConflicts.inc();
      if (state === '23505') throw new UniqueViolationError((error as { constraint?: string }).constraint ?? 'unknown');
      // Classe 22 = dado que o banco não aceita (ex.: valor acima de numeric(20,2)). Reenviar não resolve.
      if (state?.startsWith('22')) throw new ValidationError('value rejected by the database (out of range or invalid encoding)');
      throw error;
    }
  }
}

class MikroTxStore implements TxStore {
  // Registros gerenciados carregados/criados nesta transação. Salvar = copiar o estado do domínio
  // para o registro; o Unit of Work calcula o diff e emite INSERT/UPDATE no flush, antes do commit.
  private readonly wallets = new Map<string, WalletRecord>();
  private readonly transactions = new Map<string, WagerTransactionRecord>();
  private readonly outbox = new Map<string, OutboxRecord>();

  constructor(private readonly em: EntityManager) {}

  async insertInbox(message: InboxMessage): Promise<'inserted' | 'duplicate' | 'conflict'> {
    const inserted = await this.em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, ?)
       on conflict do nothing returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (inserted.length === 1) return 'inserted';
    const [stored] = await this.em.execute(`select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`, [
      message.consumerName,
      message.messageId,
    ]);
    return stored?.payload_hash === message.payloadHash ? 'duplicate' : 'conflict';
  }

  async markInboxProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(`update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`, [
      message.processedAt,
      message.consumerName,
      message.messageId,
    ]);
  }

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, walletId, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!record) return undefined;
    this.wallets.set(record.id, record);
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      balance: money(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  saveWallet(wallet: Wallet): void {
    const state = {
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
    const record = this.wallets.get(wallet.id);
    if (record) Object.assign(record, state);
    else this.wallets.set(wallet.id, this.em.create(WalletRecord, { id: wallet.id, ...state }));
  }

  findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    return this.findTransaction({ id });
  }

  findTransactionByKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findTransaction({ idempotencyKey });
  }

  findTransactionByProviderRef(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findTransaction({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  saveTransaction(tx: WagerTransaction): void {
    const state = {
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      resultingBalance: tx.resultingBalance?.toJSON().amount ?? null,
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt ?? null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
    };
    const record = this.transactions.get(tx.id);
    if (record) Object.assign(record, state);
    else this.transactions.set(tx.id, this.em.create(WagerTransactionRecord, { id: tx.id, ...state }));
  }

  async findDuePendingReferences(limit: number, now: Date): Promise<{ id: string; walletId: string }[]> {
    const found = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: 'asc' }, limit, fields: ['id', 'walletId'] },
    );
    return found.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  addLedgerEntry(entry: WalletLedgerEntry): void {
    this.em.create(LedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
  }

  enqueue(event: IntegrationEvent<unknown>): void {
    const message = OutboxMessage.enqueue(event);
    this.em.create(OutboxRecord, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: null,
      publishedAt: null,
    });
  }

  async claimDueOutbox(limit: number, now: Date): Promise<OutboxMessage[]> {
    // `sequence` (identity) dá a ordem de inserção; SKIP LOCKED pula linhas já pegas por outro publisher.
    const claimed: { id: string }[] = await this.em.execute(
      `select o.id from outbox_messages o
        where o.published_at is null and (o.next_attempt_at is null or o.next_attempt_at <= ?)
          -- não ultrapassa um evento anterior da mesma wallet que falhou e está em backoff
          and not exists (
            select 1 from outbox_messages earlier
             where earlier.aggregate_id = o.aggregate_id and earlier.published_at is null
               and earlier.sequence < o.sequence and earlier.next_attempt_at > ?)
        order by o.sequence limit ? for update of o skip locked`,
      [now, now, limit],
    );
    if (claimed.length === 0) return [];
    const order = new Map(claimed.map((row, index) => [row.id, index]));
    const found = await this.em.find(OutboxRecord, { id: { $in: [...order.keys()] } });
    return found
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .map((record) => {
        this.outbox.set(record.id, record);
        return OutboxMessage.rehydrate({
          id: record.id,
          aggregateId: record.aggregateId,
          eventType: record.eventType,
          payload: record.payload,
          occurredAt: record.occurredAt,
          attempts: record.attempts,
          nextAttemptAt: record.nextAttemptAt ?? undefined,
          publishedAt: record.publishedAt ?? undefined,
        });
      });
  }

  saveOutbox(message: OutboxMessage): void {
    const record = this.outbox.get(message.id);
    if (!record) throw new Error(`outbox message ${message.id} was not claimed in this transaction`);
    record.attempts = message.attempts;
    record.nextAttemptAt = message.nextAttemptAt ?? null;
    record.publishedAt = message.publishedAt ?? null;
  }

  private async findTransaction(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where);
    if (!record) return undefined;
    this.transactions.set(record.id, record);
    // O saldo observado é da wallet, cuja moeda pode diferir da moeda da operação (CURRENCY_MISMATCH).
    // Normalmente a wallet já está no Identity Map (foi travada antes), então isto não vai ao banco.
    const wallet = await this.em.findOne(WalletRecord, record.walletId);
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount, record.currency),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode: (record.failureCode as FailureCode | null) ?? undefined,
      processedAt: record.processedAt ?? undefined,
      resultingBalance: record.resultingBalance ? money(record.resultingBalance, wallet?.currency ?? record.currency) : undefined,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
    });
  }
}
