import { Money } from "../money/money";
import { InvalidTransactionStateError, ValidationError } from "../shared/errors";
import type { FailureCode } from "../shared/failure-code";
import { newId } from "../shared/id";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";

export enum WagerTransactionKind {
  /** Internal: credit applied when a wallet is opened with a positive balance. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet (only exists in memory before the first decision). */
  Pending = "PENDING",
  /** Waiting for the referenced transaction to arrive. */
  PendingReference = "PENDING_REFERENCE",
  /** Applied. Terminal. */
  Processed = "PROCESSED",
  /** Business rule violation. Terminal. */
  Rejected = "REJECTED",
  /** Permanent infrastructure error. Terminal and auditable. */
  Failed = "FAILED",
}

/** Kinds a provider may submit (OPENING is internal only). */
export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  /** Correlation id of the request/message that created it (traceability). */
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  id: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Wallet balance observed when the transaction reached its current state. */
  balanceAfter?: Money;
  /** How many times the pending-reference worker already tried to resolve it. */
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

/**
 * A provider operation (or the internal OPENING credit) and its lifecycle.
 *
 * Valid transitions:
 *
 *   PENDING ──────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (rescheduled)
 *   PROCESSED, REJECTED, FAILED ─► (terminal, any transition throws)
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Id at the provider, not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _balanceAfter?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Creates a transaction in PENDING after validating per-kind requirements. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = new WagerTransaction(
      newId(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new ValidationError(`${tx.kind} requires referenceExternalTransactionId`);
    }
    if (tx.kind === WagerTransactionKind.Bet && tx.referenceExternalTransactionId) {
      throw new ValidationError("BET cannot reference another transaction");
    }
    if (tx.referenceExternalTransactionId === tx.externalTransactionId) {
      throw new ValidationError("A transaction cannot reference itself");
    }
    if (tx.kind !== WagerTransactionKind.Loss && !tx.money.isPositive()) {
      throw new ValidationError(`${tx.kind} amount must be greater than zero`);
    }
    return tx;
  }

  /** Rebuilds a persisted transaction. Does not re-validate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions --------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /**
   * Parks the transaction until its reference shows up. Each call counts as
   * one resolution attempt and schedules the next one (`nextAttemptAt`).
   */
  markPendingReference(balanceObserved: Money, nextAttemptAt: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._balanceAfter = balanceObserved;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, balanceObserved: Money, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceObserved;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- domain queries -----------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS only records the outcome of a round; it never moves money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger entry this transaction produces.
   * ROLLBACK mirrors the referenced transaction (undoing a BET credits,
   * undoing a WIN/REFUND debits).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new ValidationError("ROLLBACK direction depends on its reference");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new ValidationError("LOSS does not produce ledger entries");
    }
  }

  private assertNotTerminal(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, target);
    }
  }
}
