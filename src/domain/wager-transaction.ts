import { InvalidTransactionStateError, InvalidValueError } from './errors';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: wallet opening credit
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // accepted, not applied yet (in-memory only)
  PendingReference = 'PENDING_REFERENCE', // waiting for the referenced transaction
  Processed = 'PROCESSED', // applied (terminal)
  Rejected = 'REJECTED', // business rule violation (terminal)
  Failed = 'FAILED', // permanent infrastructure error (terminal, auditable)
}

/** Kinds a provider may submit (OPENING is internal). */
export const EXTERNAL_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Valid transitions (anything else throws InvalidTransactionStateError):
 *
 *   PENDING           -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | PENDING_REFERENCE (retry) | FAILED
 *   PROCESSED | REJECTED | FAILED  -> (terminal)
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Which kinds each kind may reference. */
const ALLOWED_REFERENCES: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export const INTERNAL_PROVIDER_ID = 'internal';

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
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** balance observed when the outcome was decided — returned on replays */
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
  updatedAt: Date;
}

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
    /** provider-side id — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
    private _updatedAt: Date,
    private readonly _persistedStatus: WagerTransactionStatus | undefined,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && props.providerId !== INTERNAL_PROVIDER_ID) {
      throw new InvalidValueError('OPENING is an internal transaction kind');
    }
    if (!props.money.isPositive()) {
      throw new InvalidValueError('Transaction amount must be positive');
    }
    const reference = props.referenceExternalTransactionId;
    const tx = new WagerTransaction(
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
      reference,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.createdAt,
      undefined,
    );
    if (tx.requiresReference() && !reference) {
      throw new InvalidValueError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (reference && ALLOWED_REFERENCES[props.kind].length === 0) {
      throw new InvalidValueError(`${props.kind} cannot reference another transaction`);
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidValueError('A transaction cannot reference itself');
    }
    return tx;
  }

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
      state.nextReferenceCheckAt,
      state.updatedAt,
      state.status,
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
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  /** Status currently stored in the database (undefined when never persisted). */
  get persistedStatus(): WagerTransactionStatus | undefined {
    return this._persistedStatus;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed, at);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = balanceAfter;
    this._nextReferenceCheckAt = undefined;
  }

  /** First call parks the transaction; subsequent calls count a failed resolution attempt. */
  markPendingReference(nextCheckAt: Date, at: Date, observedBalance: Money): void {
    const wasPending = this._status === WagerTransactionStatus.PendingReference;
    this.transitionTo(WagerTransactionStatus.PendingReference, at);
    if (wasPending) {
      this._referenceAttempts += 1;
    }
    this._nextReferenceCheckAt = nextCheckAt;
    this._resultBalance = observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected, at);
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed, at);
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  isNew(): boolean {
    return this._persistedStatus === undefined;
  }

  /** false for LOSS: it records the outcome without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  canReference(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCES[this.kind].includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET debits; WIN/REFUND/OPENING credit; ROLLBACK inverts its reference.
   * LOSS has no direction (callers must check affectsBalance first).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidValueError('ROLLBACK direction depends on its reference');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidValueError('LOSS does not move balance');
    }
  }

  private transitionTo(next: WagerTransactionStatus, at: Date): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }
    this._status = next;
    this._updatedAt = at;
  }
}
