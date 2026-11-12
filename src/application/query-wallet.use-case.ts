import { Inject, Injectable } from "@nestjs/common";
import { TransactionRunner } from "../database/transaction-runner";
import type { MoneyProps } from "../domain/money/money";
import { NotFoundError, ValidationError } from "../domain/shared/errors";
import type { FailureCode } from "../domain/shared/failure-code";
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wagering/wager-transaction";

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAfter?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

/**
 * Read-only queries for wallets, cursor-paginated ledger entries and transactions.
 */
@Injectable()
export class QueryWalletUseCase {
  constructor(@Inject(TransactionRunner) private readonly txRunner: TransactionRunner) {}

  async getWallet(walletIdInput: string) {
    const walletId = walletIdInput.toLowerCase();
    const wallet = await this.txRunner.read((ctx) => ctx.wallets.findById(walletId));
    if (!wallet) {
      throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
    }
    return wallet.toJSON();
  }

  async getLedger(walletIdInput: string, cursor: string | undefined, limit: number) {
    const walletId = walletIdInput.toLowerCase();
    const afterSeq = cursor ? decodeCursor(cursor, walletId) : null;

    return this.txRunner.read(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
      }

      const page = await ctx.ledger.page(walletId, afterSeq, limit);
      return {
        walletId: wallet.id,
        items: page.entries.map((entry) => entry.toJSON()),
        nextCursor: page.lastSeq ? encodeCursor(wallet.id, page.lastSeq) : null,
      };
    });
  }

  async getTransactionById(transactionIdInput: string): Promise<TransactionView> {
    const transactionId = transactionIdInput.toLowerCase();
    const tx = await this.txRunner.read((ctx) => ctx.transactions.findById(transactionId));
    if (!tx) {
      throw new NotFoundError("TRANSACTION_NOT_FOUND", `Transaction ${transactionId} not found`);
    }
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.txRunner.read((ctx) =>
      ctx.transactions.findByExternalId(providerId.trim(), externalTransactionId.trim()),
    );
    if (!tx) {
      throw new NotFoundError(
        "TRANSACTION_NOT_FOUND",
        `Transaction ${externalTransactionId} for provider ${providerId} not found`,
      );
    }
    return toTransactionView(tx);
  }
}

function encodeCursor(walletId: string, seq: string): string {
  return Buffer.from(JSON.stringify({ w: walletId, s: seq }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedWalletId: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      w?: unknown;
      s?: unknown;
    };
    if (
      typeof parsed.w !== "string" ||
      typeof parsed.s !== "string" ||
      !/^\d+$/.test(parsed.s) ||
      parsed.w.toLowerCase() !== expectedWalletId
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed.s;
  } catch {
    throw new ValidationError("Invalid pagination cursor");
  }
}

function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.balanceAfter ? { balanceAfter: tx.balanceAfter.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

