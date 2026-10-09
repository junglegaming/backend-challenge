import { Money } from "../../../shared/domain/money";
import { LedgerDirection, oppositeDirection } from "../../wallet/domain/ledger-direction";
import { FailureCode } from "./failure-code";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./wager-errors";
import {
  ALLOWED_REFERENCE_KINDS,
  TERMINAL_STATUSES,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction-kind";

export interface CreateWagerTransactionProps {
  id: string;
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
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Wallet balance observed when the transaction reached its current outcome (replayed verbatim). */
  resultBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceRetryAt?: Date | undefined;
}

/**
 * Valid transitions. Everything else throws InvalidTransactionStateError.
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *   PROCESSED / REJECTED / FAILED: terminal
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, ReadonlySet<WagerTransactionStatus>>> = {
  [WagerTransactionStatus.Pending]: new Set([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ]),
  [WagerTransactionStatus.PendingReference]: new Set([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ]),
  [WagerTransactionStatus.Processed]: new Set(),
  [WagerTransactionStatus.Rejected]: new Set(),
  [WagerTransactionStatus.Failed]: new Set(),
};

const REQUIRED_STRING_FIELDS = [
  "id",
  "providerId",
  "externalTransactionId",
  "idempotencyKey",
  "payloadHash",
  "walletId",
  "playerId",
  "roundId",
  "gameId",
] as const;

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
    /** Provider-side id of the referenced transaction — not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceRetryAt?: Date,
  ) {}

  /** Born PENDING. Validates per-kind reference requirements and amount sign. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof props[field] !== "string" || props[field].trim() === "") {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    const allowedRefs = ALLOWED_REFERENCE_KINDS[props.kind];
    if (!allowedRefs) throw new InvalidWagerTransactionError(`unknown kind ${String(props.kind)}`);
    const ref = props.referenceExternalTransactionId;
    const requiresRef =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresRef && !ref) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (ref !== undefined && allowedRefs.length === 0) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot reference another transaction`);
    }
    if (ref !== undefined && ref === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("a transaction cannot reference itself");
    }
    if (props.money.isNegative()) throw new InvalidWagerTransactionError("amount cannot be negative");
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be positive`);
    }

    return new WagerTransaction(
      props.id,
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
      ref,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
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
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceRetryAt,
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

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceRetryAt(): Date | undefined {
    return this._nextReferenceRetryAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceRetryAt = undefined;
  }

  /** Reference not found yet: park the transaction until `nextRetryAt`. */
  markPendingReference(nextRetryAt: Date, resultBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._nextReferenceRetryAt = nextRetryAt;
    this._resultBalance = resultBalance;
  }

  /** Another unsuccessful reference lookup while PENDING_REFERENCE (not a status transition). */
  scheduleReferenceRetry(nextRetryAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, WagerTransactionStatus.PendingReference);
    }
    this._referenceAttempts += 1;
    this._nextReferenceRetryAt = nextRetryAt;
  }

  reject(code: FailureCode, at: Date, resultBalance: Money, referenceTransactionId?: string): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._referenceTransactionId = referenceTransactionId;
    this._nextReferenceRetryAt = undefined;
  }

  /** Permanent infrastructure failure, kept for audit. `resultBalance` is the balance observed (unchanged). */
  fail(code: FailureCode, at: Date, resultBalance?: Money): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceRetryAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** A declared reference is a dependency even when optional (WIN/LOSS → BET): it must resolve before applying. */
  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  canReference(reference: WagerTransaction): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET → DEBIT; WIN/REFUND/OPENING → CREDIT; ROLLBACK → inverse of the referenced transaction's direction.
   * LOSS has no ledger effect and asking for its direction is a programming error.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference)
          throw new InvalidWagerTransactionError("ROLLBACK direction requires the referenced transaction");
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS does not move balance");
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].has(next))
      throw new InvalidTransactionStateError(this.id, this._status, next);
    this._status = next;
  }
}
