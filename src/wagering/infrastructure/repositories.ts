import { LockMode } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { TransactionContext } from "../../shared/application/unit-of-work";
import { managerFor } from "../../shared/infrastructure/unit-of-work";
import {
  LedgerRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "../application/ports/repositories";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import {
  ledgerFromRecord,
  ledgerToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from "./mappers";
import { LedgerRecord, WagerTransactionRecord, WalletRecord } from "./records";

@Injectable()
export class SqlWalletRepository extends WalletRepository {
  override async lockNextWithDueReference(
    tx: TransactionContext,
    now: Date,
  ): Promise<Wallet | null> {
    const em = managerFor(tx);
    const rows = await em.execute<Record<string, unknown>[]>(
      `SELECT w.* FROM wallets w WHERE EXISTS (
        SELECT 1 FROM wager_transactions t WHERE t.wallet_id = w.id
        AND t.status = 'PENDING_REFERENCE' AND t.next_reference_attempt_at <= ?
      ) ORDER BY w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
      [now],
    );
    return rows[0] ? walletFromRecord(em.map(WalletRecord, rows[0])) : null;
  }
  override async find(tx: TransactionContext, id: string): Promise<Wallet | null> {
    const row = await managerFor(tx).findOne(WalletRecord, { id }, { refresh: true });
    return row ? walletFromRecord(row) : null;
  }
  override async lock(tx: TransactionContext, id: string): Promise<Wallet | null> {
    const row = await managerFor(tx).findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return row ? walletFromRecord(row) : null;
  }
  override async insert(tx: TransactionContext, wallet: Wallet): Promise<void> {
    await managerFor(tx).insert(WalletRecord, walletToRecord(wallet));
  }
  override async save(tx: TransactionContext, wallet: Wallet): Promise<void> {
    await managerFor(tx).nativeUpdate(
      WalletRecord,
      { id: wallet.id },
      { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
  }
}

@Injectable()
export class SqlWagerTransactionRepository extends WagerTransactionRepository {
  override async findNextDueReference(
    tx: TransactionContext,
    walletId: string,
    now: Date,
  ): Promise<WagerTransaction | null> {
    const em = managerFor(tx);
    const rows = await em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wager_transactions WHERE wallet_id = ? AND status = 'PENDING_REFERENCE'
       AND next_reference_attempt_at <= ? ORDER BY next_reference_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [walletId, now],
    );
    return rows[0] ? transactionFromRecord(em.map(WagerTransactionRecord, rows[0])) : null;
  }
  override async find(tx: TransactionContext, id: string): Promise<WagerTransaction | null> {
    const row = await managerFor(tx).findOne(WagerTransactionRecord, { id }, { refresh: true });
    return row ? transactionFromRecord(row) : null;
  }
  override async findByKey(
    tx: TransactionContext,
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const row = await managerFor(tx).findOne(
      WagerTransactionRecord,
      { providerId, idempotencyKey },
      { refresh: true },
    );
    return row ? transactionFromRecord(row) : null;
  }
  override async findByExternalId(
    tx: TransactionContext,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await managerFor(tx).findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      { refresh: true },
    );
    return row ? transactionFromRecord(row) : null;
  }
  override async insert(tx: TransactionContext, transaction: WagerTransaction): Promise<void> {
    await managerFor(tx).insert(WagerTransactionRecord, transactionToRecord(transaction));
  }
  override async save(tx: TransactionContext, transaction: WagerTransaction): Promise<void> {
    await managerFor(tx).nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      {
        status: transaction.status,
        referenceTransactionId: transaction.referenceTransactionId,
        failureCode: transaction.failureCode,
        observedBalance: transaction.observedBalance?.toString(),
        observedCurrency: transaction.observedBalance?.currency,
        processedAt: transaction.processedAt,
        nextReferenceAttemptAt: transaction.nextAttemptAt,
        referenceAttempts: transaction.referenceAttempts,
        updatedAt: new Date(),
      },
    );
  }
  override async hasProcessedReversal(
    tx: TransactionContext,
    referenceTransactionId: string,
  ): Promise<boolean> {
    return (
      (await managerFor(tx).count(WagerTransactionRecord, {
        referenceTransactionId,
        status: WagerTransactionStatus.Processed,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      })) > 0
    );
  }
}

@Injectable()
export class SqlLedgerRepository extends LedgerRepository {
  override async insert(tx: TransactionContext, entry: WalletLedgerEntry): Promise<void> {
    await managerFor(tx).insert(LedgerRecord, ledgerToRecord(entry));
  }
  override async list(
    tx: TransactionContext,
    walletId: string,
    afterVersion = 0,
    limit = 1000,
  ): Promise<WalletLedgerEntry[]> {
    const rows = await managerFor(tx).find(
      LedgerRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: "asc" }, limit },
    );
    return rows.map(ledgerFromRecord);
  }
}
