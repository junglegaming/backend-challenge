import type { SubmissionFailure } from "../domain/submission-failure";
import type { WagerTransaction } from "../domain/wager-transaction";

export interface ExternalRef {
  providerId: string;
  externalTransactionId: string;
}

/** Idempotency keys are unique per provider (provider_id, idempotency_key). */
export interface IdempotencyRef {
  providerId: string;
  idempotencyKey: string;
}

export interface ClaimedPendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Single round trip for both uniqueness keys, both scoped to the provider: idempotency key and external id. */
  findIdempotencyCandidates(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<{ byKey?: WagerTransaction; byExternal?: WagerTransaction }>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Row lock on the transaction; callers must already hold the wallet lock (lock ordering: wallet → transaction). */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  /** Multi-row insert (a unique violation on an idempotency constraint surfaces as a retryable race). */
  insertMany(txs: readonly WagerTransaction[]): Promise<void>;
  /** One query for every (provider, idempotency key) and every (provider, external id) of a batch. */
  findIdempotencyCandidatesMany(
    keys: readonly IdempotencyRef[],
    pairs: readonly ExternalRef[],
  ): Promise<WagerTransaction[]>;
  findByProviderExternalIds(pairs: readonly ExternalRef[]): Promise<WagerTransaction[]>;
  /** Ids among `transactionIds` that already have a PROCESSED REFUND/ROLLBACK. */
  reversedAmong(transactionIds: readonly string[]): Promise<Set<string>>;
  /** Batch version of nudgeDependents (same wallet only). */
  nudgeDependentsMany(walletId: string, references: readonly ExternalRef[], now: Date): Promise<number>;
  /** Persists the mutable lifecycle columns (status, outcome, retry bookkeeping). */
  update(tx: WagerTransaction): Promise<void>;
  /** True when a PROCESSED REFUND/ROLLBACK already references `transactionId`. */
  isReversed(transactionId: string): Promise<boolean>;
  /** Makes PENDING_REFERENCE dependents of a transaction that just became terminal due now (same wallet only). */
  nudgeDependents(
    walletId: string,
    providerId: string,
    externalTransactionId: string,
    now: Date,
  ): Promise<number>;
  /**
   * Claims due PENDING_REFERENCE transactions with FOR UPDATE SKIP LOCKED and pushes their next retry to
   * `leaseUntil`, so a crashed worker's claim simply expires and another instance picks it up.
   */
  claimDuePendingReferences(now: Date, limit: number, leaseUntil: Date): Promise<ClaimedPendingReference[]>;
  countPendingReferences(): Promise<number>;
}

/** Append-only audit of submissions that did not become a business outcome. */
export interface SubmissionFailureRepository {
  insert(failure: SubmissionFailure): Promise<void>;
  /** Newest first. */
  listByExternalId(
    providerId: string,
    externalTransactionId: string,
    limit: number,
  ): Promise<SubmissionFailure[]>;
  /** Retention: deletes records older than `cutoff` (rows are immutable otherwise). */
  purgeOccurredBefore(cutoff: Date, limit: number): Promise<number>;
}
