import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config";
import { isLockConflict, isUniqueViolation } from "../database/database-errors";
import { type TransactionContext, TransactionRunner } from "../database/transaction-runner";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/events";
import type { IntegrationEvent } from "../domain/events/integration-event";
import { InboxMessage } from "../domain/messaging/inbox-message";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../domain/money/money";
import { ConflictError, NotFoundError, ValidationError } from "../domain/shared/errors";
import type { FailureCode } from "../domain/shared/failure-code";
import { newId } from "../domain/shared/id";
import { computePayloadHash } from "../domain/wagering/payload-hash";
import { WagerRules } from "../domain/wagering/wager-rules";
import {
  SUBMITTABLE_KINDS,
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import { LedgerDirection } from "../domain/wallet/wallet-ledger-entry";
import { currentContext, enrichContext } from "../observability/context";
import { logger } from "../observability/logger";
import { metrics } from "../observability/metrics";

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  channel: "http" | "sqs";
  /** Present when invoked from the SQS consumer to guarantee persistent inbox deduplication. */
  inbox?: {
    consumerName: string;
    messageId: string;
  };
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
  /** True when the SQS message was already recorded in `inbox_messages`. */
  inboxDuplicate?: boolean;
}

/**
 * Single entry point for processing a wager operation from either HTTP or SQS.
 *
 * Guarantees enforced in one SQL transaction:
 *  1. Persistent inbox deduplication `(consumerName, messageId)` when coming from SQS;
 *  2. Row-level pessimistic lock on the target `Wallet` (`SELECT ... FOR UPDATE`);
 *  3. Persistent idempotency by `(providerId, idempotencyKey)` and `(providerId, externalTransactionId)`
 *     using a canonical SHA-256 `payloadHash` to distinguish replays from conflicts;
 *  4. Atomic mutation of `wallets`, `wager_transactions`, `wallet_ledger_entries` and `outbox_messages`.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(TransactionRunner) private readonly txRunner: TransactionRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const stopTimer = metrics.processingDuration.startTimer({ channel: command.channel });
    try {
      return await this.executeInternal(command);
    } catch (error) {
      if (isLockConflict(error)) {
        metrics.lockConflicts.inc();
      }
      throw error;
    } finally {
      stopTimer();
    }
  }

  private async executeInternal(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    if (!(SUBMITTABLE_KINDS as readonly string[]).includes(command.kind)) {
      throw new ValidationError(`Kind ${String(command.kind)} cannot be submitted by a provider`);
    }

    const walletId = command.walletId.toLowerCase();
    const playerId = command.playerId.toLowerCase();
    const providerId = command.providerId.trim();
    const externalTransactionId = command.externalTransactionId.trim();
    const idempotencyKey = command.idempotencyKey.trim();
    const money = Money.from(command.money);

    enrichContext({
      walletId,
      providerId,
      channel: command.channel,
      ...(command.inbox ? { messageId: command.inbox.messageId } : {}),
    });

    const payloadHash = computePayloadHash({
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    const normalized: ProcessWagerCommand = {
      ...command,
      providerId,
      externalTransactionId,
      idempotencyKey,
      playerId,
      walletId,
    };

    try {
      return await this.txRunner.run((ctx) => this.runInTransaction(ctx, normalized, money, payloadHash));
    } catch (error) {
      // If two concurrent requests with the same key targeted different wallets (or raced before lock),
      // the unique index rejects the loser. Re-read the winner to classify replay vs conflict.
      if (
        isUniqueViolation(error, "wager_tx_provider_idempotency_uq") ||
        isUniqueViolation(error, "wager_tx_provider_external_uq")
      ) {
        return await this.txRunner.read((ctx) =>
          this.resolveExistingAfterConflict(ctx, normalized, payloadHash),
        );
      }
      throw error;
    }
  }

  private async runInTransaction(
    ctx: TransactionContext,
    command: ProcessWagerCommand,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const now = new Date();
    const correlationId = currentContext().correlationId ?? newId();

    // 1. Fast idempotency check before acquiring the wallet row lock (handles replays on non-existent wallets too).
    const preExisting = await this.findExisting(ctx, command);
    if (preExisting) {
      const replay = await this.buildReplayResult(ctx, preExisting, command, payloadHash);
      if (command.inbox) {
        const inboxMsg = InboxMessage.receive({
          consumerName: command.inbox.consumerName,
          messageId: command.inbox.messageId,
          payloadHash,
          receivedAt: now,
        });
        inboxMsg.markProcessed(now);
        const inserted = await ctx.inbox.tryInsert(inboxMsg);
        if (!inserted) {
          metrics.duplicates.inc({ type: "inbox", channel: command.channel });
          return { ...replay, inboxDuplicate: true };
        }
      }
      return replay;
    }

    // 2. If invoked from SQS, claim the inbox slot inside the SQL transaction.
    if (command.inbox) {
      const inboxMsg = InboxMessage.receive({
        consumerName: command.inbox.consumerName,
        messageId: command.inbox.messageId,
        payloadHash,
        receivedAt: now,
      });
      inboxMsg.markProcessed(now);
      const inserted = await ctx.inbox.tryInsert(inboxMsg);
      if (!inserted) {
        metrics.duplicates.inc({ type: "inbox", channel: command.channel });
        const existingForInbox = await this.findExisting(ctx, command);
        if (existingForInbox) {
          const replay = await this.buildReplayResult(ctx, existingForInbox, command, payloadHash, false);
          return { ...replay, inboxDuplicate: true };
        }
        const wallet = await ctx.wallets.findById(command.walletId);
        return {
          transactionId: "inbox-duplicate",
          status: WagerTransactionStatus.Processed,
          balance: (wallet?.balance ?? Money.zero(money.currency)).toJSON(),
          idempotentReplay: true,
          inboxDuplicate: true,
        };
      }
    }

    // 3. Acquire pessimistic row lock on the target wallet (unit of concurrency = walletId).
    const wallet = await ctx.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${command.walletId} not found`);
    }

    // 4. Re-check idempotency under the wallet lock so parallel submissions of the same bet never double-debit.
    const existing = await this.findExisting(ctx, command);
    if (existing) {
      return this.buildReplayResult(ctx, existing, command, payloadHash);
    }

    // 5. Build and evaluate the domain transaction.
    const tx = WagerTransaction.create({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId,
      createdAt: now,
    });

    enrichContext({ transactionId: tx.id });

    await this.evaluateAndPersist(ctx, tx, wallet, now, correlationId);

    metrics.transactions.inc({
      kind: tx.kind,
      status: tx.status,
      channel: command.channel,
    });

    logger.info(
      {
        transactionId: tx.id,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
      },
      "Wager transaction processed",
    );

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: (tx.balanceAfter ?? wallet.balance).toJSON(),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay: false,
    };
  }

  /**
   * Evaluates `WagerRules.decide()` and writes the resulting state, wallet movement,
   * ledger entry and integration events to the current SQL transaction.
   *
   * Also reused by the pending-reference worker when a parked transaction is retried.
   */
  async evaluateAndPersist(
    ctx: TransactionContext,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    correlationId: string,
    isExistingRow = false,
  ): Promise<void> {
    const reference = tx.referenceExternalTransactionId
      ? await ctx.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : null;

    const referenceAlreadyReversed = reference ? await ctx.transactions.isReversed(reference.id) : false;

    const decision = WagerRules.decide({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed,
    });

    const eventCtx = { correlationId, causationId: tx.id, occurredAt: now };
    const events: IntegrationEvent<unknown>[] = [];

    if (decision.outcome === "apply") {
      const previousVersion = wallet.version;
      const entry =
        decision.direction === LedgerDirection.Debit
          ? wallet.debit(tx.money, tx.id, now)
          : decision.direction === LedgerDirection.Credit
            ? wallet.credit(tx.money, tx.id, now)
            : undefined;

      tx.markProcessed(reference?.id, wallet.balance, now);

      if (isExistingRow) {
        await ctx.transactions.updateState(tx);
      } else {
        await ctx.transactions.insert(tx);
      }

      if (entry) {
        await ctx.wallets.update(wallet, previousVersion);
        await ctx.ledger.insert(entry);
        events.push(WalletBalanceChanged.from(wallet, entry, eventCtx));
      }
      events.push(WagerTransactionProcessed.from(tx, wallet, eventCtx));
    } else if (decision.outcome === "reject") {
      tx.reject(decision.failureCode, wallet.balance, now);
      if (isExistingRow) {
        await ctx.transactions.updateState(tx);
      } else {
        await ctx.transactions.insert(tx);
      }
      events.push(WagerTransactionRejected.from(tx, decision.failureCode, eventCtx));
    } else {
      // Reference has not arrived yet: park as PENDING_REFERENCE with exponential backoff.
      const delayMs = this.config.pendingReference.baseDelayMs * 2 ** tx.referenceAttempts;
      const nextAttemptAt = new Date(now.getTime() + delayMs);
      tx.markPendingReference(wallet.balance, nextAttemptAt);
      if (isExistingRow) {
        await ctx.transactions.updateState(tx);
      } else {
        await ctx.transactions.insert(tx);
      }
      if (!isExistingRow) {
        events.push(WagerTransactionPendingReference.from(tx, eventCtx));
      }
    }

    await ctx.outbox.insert(events.map((e) => OutboxMessage.enqueue(e)));
  }

  private async findExisting(
    ctx: TransactionContext,
    command: ProcessWagerCommand,
  ): Promise<WagerTransaction | null> {
    const byKey = await ctx.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (byKey) {
      return byKey;
    }
    return ctx.transactions.findByExternalId(command.providerId, command.externalTransactionId);
  }

  private async resolveExistingAfterConflict(
    ctx: TransactionContext,
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const existing = await this.findExisting(ctx, command);
    if (!existing) {
      throw new ConflictError("IDEMPOTENCY_CONFLICT", "Concurrent idempotency conflict");
    }
    return this.buildReplayResult(ctx, existing, command, payloadHash);
  }

  private async buildReplayResult(
    ctx: TransactionContext,
    existing: WagerTransaction,
    command: ProcessWagerCommand,
    payloadHash: string,
    recordMetric = true,
  ): Promise<ProcessWagerResult> {
    enrichContext({ transactionId: existing.id });

    const sameIdentity =
      existing.idempotencyKey === command.idempotencyKey &&
      existing.externalTransactionId === command.externalTransactionId &&
      existing.matchesPayload(payloadHash);

    if (!sameIdentity) {
      metrics.duplicates.inc({ type: "conflict", channel: command.channel });
      throw new ConflictError(
        "IDEMPOTENCY_CONFLICT",
        `Idempotency conflict for key "${command.idempotencyKey}" or externalTransactionId "${command.externalTransactionId}"`,
        existing.id,
      );
    }

    if (recordMetric) {
      metrics.duplicates.inc({ type: "replay", channel: command.channel });
    }

    let observedBalance = existing.balanceAfter;
    if (!observedBalance) {
      const wallet = await ctx.wallets.findById(existing.walletId);
      observedBalance = wallet?.balance ?? Money.zero(existing.money.currency);
    }

    return {
      transactionId: existing.id,
      status: existing.status,
      balance: observedBalance.toJSON(),
      ...(existing.failureCode ? { failureCode: existing.failureCode } : {}),
      idempotentReplay: true,
    };
  }
}

