import {
  type ApplicationError,
  IdempotencyConflictError,
  ValidationError,
  WalletNotFoundForSubmissionError,
} from "../../../shared/application/errors";
import {
  type AppLogger,
  type AppMetrics,
  type Channel,
  logContext,
} from "../../../shared/application/observability";
import type { TransactionScope, UnitOfWork } from "../../../shared/application/unit-of-work";
import { DomainError } from "../../../shared/domain/domain-error";
import { Money, type MoneyProps } from "../../../shared/domain/money";
import type { Clock, IdGenerator } from "../../../shared/domain/ports";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { counterpartyAccountFor } from "../domain/counterparty";
import { WagerTransactionFailed } from "../domain/events/wagering-events";
import type { FailureCode } from "../domain/failure-code";
import { computeWagerPayloadHash } from "../domain/payload-hash";
import { type ReferenceLookup, WagerProcessor } from "../domain/wager-processor";
import { WagerTransaction } from "../domain/wager-transaction";
import {
  EXTERNAL_KINDS,
  type ExternalWagerKind,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction-kind";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import { outboxMessagesFor } from "./wager-outcome-events";

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  channel: Channel;
  correlationId: string;
  causationId?: string | undefined;
  /** Present for queue deliveries: persistent de-duplication by (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string; payloadHash: string } | undefined;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode | undefined;
  idempotentReplay: boolean;
  /** Queue only: the inbox already had this messageId; nothing was executed. */
  duplicateMessage: boolean;
}

/** Per-item outcome of a batch: a business result, or the error that refused this item alone. */
export type BatchItemOutcome =
  | { ok: true; result: SubmitWagerResult }
  | { ok: false; error: ApplicationError };

interface PreparedItem {
  cmd: SubmitWagerCommand;
  money: Money;
  payloadHash: string;
}

/** Map key for identifiers that are unique per provider (idempotency key, external transaction id). */
const scoped = (providerId: string, value: string) => `${providerId}\u0000${value}`;

/**
 * UUIDs are case-insensitive and PostgreSQL returns them lower-case; the domain compares ids as strings. The
 * transport contracts already normalise, this keeps every other caller of the use case equally safe.
 */
const normalizeIds = (cmd: SubmitWagerCommand): SubmitWagerCommand => ({
  ...cmd,
  walletId: cmd.walletId.toLowerCase(),
  playerId: cmd.playerId.toLowerCase(),
});

/**
 * The single wagering use case shared by HTTP and SQS.
 *
 * `executeBatch` applies N submissions of ONE wallet inside ONE SQL transaction: inbox records → wallet row lock
 * (once) → idempotency and reference lookups (one query each) → business rules applied in memory, in order →
 * multi-row inserts (transactions, ledger, journal, outbox) → one wallet update → COMMIT. It is equivalent to
 * processing the items one by one: an in-memory overlay lets each item see what earlier items of the same batch
 * created (references, reversals, repeated keys, repeated messageIds), and the database constraints validate the
 * final state at COMMIT exactly as they would for N separate transactions.
 *
 * `execute` is a batch of one, so HTTP and SQS run the very same algorithm.
 */
export class ProcessWagerTransaction {
  private readonly processor = new WagerProcessor();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy,
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(cmd: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const [outcome] = await this.executeBatch([cmd]);
    if (!outcome) throw new Error("unreachable: empty batch outcome");
    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  }

  /**
   * @param cmds submissions for the SAME wallet, in arrival order.
   * @throws WalletNotFoundForSubmissionError when the wallet does not exist (nothing is committed);
   *         TransientInfrastructureError after bounded retries; unexpected errors roll the whole batch back.
   */
  async executeBatch(submitted: readonly SubmitWagerCommand[]): Promise<BatchItemOutcome[]> {
    if (submitted.length === 0) return [];
    const cmds = submitted.map(normalizeIds);
    const walletId = cmds[0]?.walletId as string;
    if (cmds.some((c) => c.walletId !== walletId)) throw new Error("a batch must target a single wallet");
    const started = performance.now();

    const prepared = cmds.map((cmd) => this.prepare(cmd));
    logContext.assign({ walletId, providerId: cmds[0]?.providerId, correlationId: cmds[0]?.correlationId });

    const outcomes = prepared.every((p) => "error" in p)
      ? prepared.map((p) => ({ ok: false as const, error: (p as { error: ApplicationError }).error }))
      : await this.uow.transaction((scope) => this.run(scope, walletId, prepared), {
          label: cmds.length > 1 ? "process-wager-batch" : "process-wager",
        });

    outcomes.forEach((outcome, i) => {
      const cmd = cmds[i] as SubmitWagerCommand;
      if (outcome.ok) this.record(cmd, outcome.result, started);
    });
    return outcomes;
  }

  /**
   * Records the submission as FAILED (terminal, auditable, no balance effect) after an *unexpected* error exhausted
   * its retries. Deliberately not used for transient infrastructure failures: those stay recoverable (DLQ redrive,
   * provider resend) instead of being frozen as a permanent answer for the idempotency key.
   *
   * Returns undefined when there is nothing valid to record against (unknown wallet, invalid contract), and the
   * existing transaction when the key was meanwhile processed (FAILED never overwrites a real outcome).
   */
  async markFailed(submitted: SubmitWagerCommand, code: FailureCode): Promise<SubmitWagerResult | undefined> {
    const cmd = normalizeIds(submitted);
    const item = this.prepare(cmd);
    if ("error" in item) return undefined;
    return this.uow.transaction(
      async (scope) => {
        const now = this.clock.now();
        const wallet = await scope.wallets.lockById(cmd.walletId);
        if (!wallet) return undefined;
        const { byKey, byExternal } = await scope.wagers.findIdempotencyCandidates(
          cmd.idempotencyKey,
          cmd.providerId,
          cmd.externalTransactionId,
        );
        const existing = byKey ?? byExternal;
        if (existing) return toResult(existing, true);

        let tx: WagerTransaction;
        try {
          tx = this.createTransaction(item, now);
        } catch {
          return undefined;
        }
        tx.fail(code, now, wallet.balance);
        await scope.wagers.insertMany([tx]);
        await scope.outbox.add([
          OutboxMessage.enqueue(
            WagerTransactionFailed.from(tx, {
              eventId: this.ids.next(),
              correlationId: cmd.correlationId,
              causationId: cmd.causationId,
              occurredAt: now,
            }),
          ),
        ]);
        // Terminal: anything waiting on this transaction as its reference can be decided now.
        await scope.wagers.nudgeDependents(tx.walletId, tx.providerId, tx.externalTransactionId, now);
        this.metrics.transactionOutcome({ kind: cmd.kind, status: tx.status, channel: cmd.channel });
        this.logger.error({ transactionId: tx.id, failureCode: code }, "wager transaction marked FAILED");
        return toResult(tx, false);
      },
      { label: "mark-wager-failed" },
    );
  }

  private async run(
    scope: TransactionScope,
    walletId: string,
    items: readonly (PreparedItem | { error: ApplicationError })[],
  ): Promise<BatchItemOutcome[]> {
    const now = this.clock.now();
    const out: (BatchItemOutcome | undefined)[] = items.map((it) =>
      "error" in it ? { ok: false, error: it.error } : undefined,
    );
    const live = items.flatMap((it, i) => ("error" in it ? [] : [{ ...it, i }]));

    // 1. Inbox first: a concurrent redelivery blocks on these keys until we commit/rollback. Rows become visible
    //    only at COMMIT, together with the effect, so they are written as processed.
    const ownedInbox = new Map<string, number>(); // messageId → index that inserted it in this batch
    const repeatedInBatch = new Map<number, number>(); // index → earlier index with the same messageId
    const alreadyInInbox = new Set<number>();
    const queued = live.filter((it) => it.cmd.inbox);
    if (queued.length > 0) {
      const first = new Map<string, number>();
      for (const it of queued) {
        const messageId = it.cmd.inbox?.messageId as string;
        const earlier = first.get(messageId);
        if (earlier === undefined) first.set(messageId, it.i);
        else repeatedInBatch.set(it.i, earlier);
      }
      const consumerName = queued[0]?.cmd.inbox?.consumerName as string;
      const inserted = await scope.inbox.tryInsertMany(
        [...first.values()].map((i) => {
          const inbox = (items[i] as PreparedItem).cmd.inbox as NonNullable<SubmitWagerCommand["inbox"]>;
          const message = InboxMessage.receive({ ...inbox, receivedAt: now });
          message.markProcessed(now);
          return message;
        }),
      );
      for (const [messageId, i] of first) {
        if (inserted.has(messageId)) ownedInbox.set(messageId, i);
        else alreadyInInbox.add(i);
      }
      if (alreadyInInbox.size > 0) {
        const previous = await scope.inbox.findMany(
          consumerName,
          [...alreadyInInbox].map((i) => (items[i] as PreparedItem).cmd.inbox?.messageId as string),
        );
        const hashByMessage = new Map(previous.map((m) => [m.messageId, m.payloadHash]));
        for (const i of alreadyInInbox) {
          const inbox = (items[i] as PreparedItem).cmd.inbox as NonNullable<SubmitWagerCommand["inbox"]>;
          const previousHash = hashByMessage.get(inbox.messageId);
          if (previousHash !== undefined && previousHash !== inbox.payloadHash) {
            out[i] = conflict("INBOX_PAYLOAD_MISMATCH", { messageId: inbox.messageId });
          }
        }
      }
    }

    // 2. Serialise on the wallet, once for the whole batch. Different wallets never contend.
    const wallet = await scope.wallets.lockById(walletId);
    if (!wallet) throw new WalletNotFoundForSubmissionError(walletId);
    const versionBefore = wallet.version;

    // 3. Idempotency (one query for every key and external id) — after the lock, so concurrent duplicates see
    //    committed originals.
    const undecided = live.filter((it) => out[it.i] === undefined);
    //    Both keys are unique per provider: one provider can never see, replay or block another's submissions.
    const persisted = await scope.wagers.findIdempotencyCandidatesMany(
      undecided.map((it) => ({ providerId: it.cmd.providerId, idempotencyKey: it.cmd.idempotencyKey })),
      undecided.map((it) => ({
        providerId: it.cmd.providerId,
        externalTransactionId: it.cmd.externalTransactionId,
      })),
    );
    const byKey = new Map(persisted.map((t) => [scoped(t.providerId, t.idempotencyKey), t]));
    const byExternal = new Map(persisted.map((t) => [scoped(t.providerId, t.externalTransactionId), t]));

    // 4. References (one query) and which of them are already reversed (one query).
    const referencePairs = undecided
      .filter((it) => it.cmd.referenceExternalTransactionId)
      .map((it) => ({
        providerId: it.cmd.providerId,
        externalTransactionId: it.cmd.referenceExternalTransactionId as string,
      }));
    const references =
      referencePairs.length > 0 ? await scope.wagers.findByProviderExternalIds(referencePairs) : [];
    for (const r of references) byExternal.set(scoped(r.providerId, r.externalTransactionId), r);
    const reversed =
      references.length > 0
        ? await scope.wagers.reversedAmong(references.map((r) => r.id))
        : new Set<string>();

    // 5. Apply in arrival order. byKey/byExternal double as the in-batch overlay: each item sees the transactions
    //    created by the items before it.
    const created: WagerTransaction[] = [];
    const ledger: { entry: WalletLedgerEntry; counterpartyAccount: string }[] = [];
    const events: OutboxMessage[] = [];
    const nudges: { providerId: string; externalTransactionId: string }[] = [];

    for (const it of live) {
      if (out[it.i] !== undefined || repeatedInBatch.has(it.i)) continue;
      const { cmd } = it;

      if (alreadyInInbox.has(it.i)) {
        // Redelivery of a committed message: answer with the original outcome.
        const original = byKey.get(scoped(cmd.providerId, cmd.idempotencyKey));
        out[it.i] = original
          ? { ok: true, result: { ...toResult(original, true), duplicateMessage: true } }
          : conflict("INBOX_PAYLOAD_MISMATCH", { messageId: cmd.inbox?.messageId });
        continue;
      }

      const existing = byKey.get(scoped(cmd.providerId, cmd.idempotencyKey));
      if (existing) {
        out[it.i] = existing.matchesPayload(it.payloadHash)
          ? { ok: true, result: toResult(existing, true) }
          : conflict("PAYLOAD_MISMATCH", { idempotencyKey: cmd.idempotencyKey, transactionId: existing.id });
        continue;
      }
      const sameExternal = byExternal.get(scoped(cmd.providerId, cmd.externalTransactionId));
      if (sameExternal) {
        out[it.i] = conflict("EXTERNAL_ID_REUSED", {
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          transactionId: sameExternal.id,
        });
        continue;
      }

      let tx: WagerTransaction;
      try {
        tx = this.createTransaction(it, now);
      } catch (error) {
        if (error instanceof ValidationError) {
          out[it.i] = { ok: false, error };
          continue;
        }
        throw error;
      }
      if (live.length === 1) logContext.assign({ transactionId: tx.id });

      let reference: ReferenceLookup | undefined;
      if (tx.referenceExternalTransactionId) {
        const ref = byExternal.get(scoped(tx.providerId, tx.referenceExternalTransactionId));
        reference = ref
          ? {
              found: true,
              transaction: ref,
              alreadyReversed:
                tx.isReversal() && ref.status === WagerTransactionStatus.Processed && reversed.has(ref.id),
            }
          : { found: false };
      }

      const outcome = this.processor.process({
        wallet,
        transaction: tx,
        reference,
        ledgerEntryId: this.ids.next(),
        at: now,
        nextReferenceRetryAt: this.retryPolicy.nextRetryAt(0, now),
        referenceRetryExhausted: false,
      });

      created.push(tx);
      byKey.set(scoped(tx.providerId, tx.idempotencyKey), tx);
      byExternal.set(scoped(tx.providerId, tx.externalTransactionId), tx);
      if (outcome.type === "PROCESSED") {
        if (outcome.ledgerEntry)
          ledger.push({ entry: outcome.ledgerEntry, counterpartyAccount: counterpartyAccountFor(tx) });
        if (tx.isReversal() && tx.referenceTransactionId) reversed.add(tx.referenceTransactionId);
      }
      // Any terminal outcome decides the dependents: PROCESSED unblocks them, REJECTED makes them
      // REFERENCE_NOT_PROCESSED right away instead of after their next backoff.
      if (outcome.type !== "PENDING_REFERENCE") {
        nudges.push({ providerId: tx.providerId, externalTransactionId: tx.externalTransactionId });
      }
      events.push(
        ...outboxMessagesFor(
          outcome,
          tx,
          wallet,
          { correlationId: cmd.correlationId, causationId: cmd.causationId, occurredAt: now },
          this.ids,
        ),
      );
      out[it.i] = { ok: true, result: toResult(tx, false) };
    }

    // Same messageId twice inside one batch: the later copy mirrors the first (replay or the same refusal).
    for (const [i, first] of repeatedInBatch) {
      const original = out[first];
      const sameContent =
        (items[i] as PreparedItem).cmd.inbox?.payloadHash ===
        (items[first] as PreparedItem).cmd.inbox?.payloadHash;
      if (!sameContent) {
        out[i] = conflict("INBOX_PAYLOAD_MISMATCH", {
          messageId: (items[i] as PreparedItem).cmd.inbox?.messageId,
        });
      } else if (original?.ok) {
        out[i] = { ok: true, result: { ...original.result, idempotentReplay: true, duplicateMessage: true } };
      } else {
        out[i] = original;
      }
    }

    // 6. Persist: multi-row writes, one wallet update for the whole batch.
    await scope.wagers.insertMany(created);
    if (ledger.length > 0) {
      await scope.wallets.saveBalance(wallet, versionBefore);
      await scope.ledger.insertMany(ledger);
    }
    await scope.outbox.add(events);
    if (nudges.length > 0) await scope.wagers.nudgeDependentsMany(walletId, nudges, now);

    // 7. Items refused inside the batch must not keep an inbox record (a later redelivery or DLQ redrive has to be
    //    evaluated again, exactly as if its transaction had rolled back).
    const refusedInbox = [...ownedInbox]
      .filter(([, i]) => out[i]?.ok === false)
      .map(([messageId]) => messageId);
    if (refusedInbox.length > 0) {
      const consumerName = (items[ownedInbox.values().next().value as number] as PreparedItem).cmd.inbox
        ?.consumerName as string;
      await scope.inbox.deleteMany(consumerName, refusedInbox);
    }

    return out.map((o) => {
      if (!o) throw new Error("unreachable: undecided batch item");
      return o;
    });
  }

  private prepare(cmd: SubmitWagerCommand): PreparedItem | { error: ApplicationError } {
    if (!(EXTERNAL_KINDS as readonly string[]).includes(cmd.kind)) {
      return {
        error: new ValidationError(`kind ${String(cmd.kind)} cannot be submitted`, { kind: cmd.kind }),
      };
    }
    try {
      return { cmd, money: Money.from(cmd.money), payloadHash: computeWagerPayloadHash(cmd) };
    } catch (error) {
      if (error instanceof DomainError)
        return { error: new ValidationError(error.message, { field: "money" }) };
      throw error;
    }
  }

  private createTransaction(item: PreparedItem, now: Date): WagerTransaction {
    const { cmd } = item;
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash: item.payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind as WagerTransactionKind,
        money: item.money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message, { code: error.code });
      throw error;
    }
  }

  private record(cmd: SubmitWagerCommand, result: SubmitWagerResult, started: number): void {
    const seconds = (performance.now() - started) / 1000;
    if (result.duplicateMessage) this.metrics.inboxDuplicate();
    if (result.idempotentReplay) this.metrics.idempotentReplay(cmd.channel);
    else this.metrics.transactionOutcome({ kind: cmd.kind, status: result.status, channel: cmd.channel });
    this.metrics.processingDuration({ channel: cmd.channel, outcome: result.status }, seconds);
    this.logger.info(
      {
        transactionId: result.transactionId,
        messageId: cmd.inbox?.messageId,
        status: result.status,
        failureCode: result.failureCode,
        kind: cmd.kind,
        idempotentReplay: result.idempotentReplay,
        duplicateMessage: result.duplicateMessage,
        durationMs: Math.round(seconds * 1000),
      },
      "wager transaction handled",
    );
  }
}

function conflict(
  reason: "PAYLOAD_MISMATCH" | "EXTERNAL_ID_REUSED" | "INBOX_PAYLOAD_MISMATCH",
  details: Record<string, unknown>,
): BatchItemOutcome {
  return { ok: false, error: new IdempotencyConflictError(reason, details) };
}

export async function lookupReference(
  scope: TransactionScope,
  tx: WagerTransaction,
): Promise<ReferenceLookup> {
  const refExternalId = tx.referenceExternalTransactionId;
  if (!refExternalId) throw new Error("lookupReference requires a reference");
  const ref = await scope.wagers.findByProviderExternalId(tx.providerId, refExternalId);
  if (!ref) return { found: false };
  const alreadyReversed =
    tx.isReversal() && ref.status === WagerTransactionStatus.Processed
      ? await scope.wagers.isReversed(ref.id)
      : false;
  return { found: true, transaction: ref, alreadyReversed };
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): SubmitWagerResult {
  const balance = tx.resultBalance;
  if (!balance) throw new Error(`transaction ${tx.id} has no result balance`);
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
    duplicateMessage: false,
  };
}
