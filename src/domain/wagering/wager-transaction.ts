import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/ledger-direction';
import { FailureCode, isBusinessFailureCode } from './failure-code';
import { computePayloadHash } from './payload-hash';
import { SUBMITTABLE_KINDS, WagerTransactionKind, WagerTransactionStatus } from './wager-enums';
import { InvalidTransactionError, InvalidTransactionStateError } from './wagering.errors';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState {
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
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
}

const S = WagerTransactionStatus;

/**
 * Valid transitions (PROCESSED, REJECTED and FAILED are terminal):
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry, reference still missing)
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [S.Pending]: [S.Processed, S.Rejected, S.Failed, S.PendingReference],
  [S.PendingReference]: [S.Processed, S.Rejected, S.Failed, S.PendingReference],
  [S.Processed]: [],
  [S.Rejected]: [],
  [S.Failed]: [],
};

const REQUIRED_TEXT_FIELDS = [
  'id',
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
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
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** A provider submission. Born PENDING. OPENING is internal and rejected here. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new InvalidTransactionError(`kind ${String(props.kind)} cannot be submitted`);
    }
    return WagerTransaction.build(props);
  }

  /** Internal: the OPENING credit of a new wallet. Never reachable from the API or the queue. */
  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      new Date(s.createdAt),
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt ? new Date(s.processedAt) : undefined,
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

  // ---- transitions (throw InvalidTransactionStateError when not allowed)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transitionTo(S.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.transitionTo(S.PendingReference);
  }

  /** Business-rule violation. */
  reject(code: FailureCode): void {
    if (!isBusinessFailureCode(code)) {
      throw new InvalidTransactionStateError(`${code} is not a business failure code`);
    }
    this.transitionTo(S.Rejected);
    this._failureCode = code;
  }

  /** Permanent infrastructure error (auditable). */
  fail(code: FailureCode): void {
    if (isBusinessFailureCode(code)) {
      throw new InvalidTransactionStateError(`${code} is a business failure code; use reject()`);
    }
    this.transitionTo(S.Failed);
    this._failureCode = code;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  /** LOSS records the result without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direction of the ledger entry this transaction produces. ROLLBACK is the inverse of its reference. */
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
          throw new InvalidTransactionError('ROLLBACK direction requires its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS does not produce a ledger entry');
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`cannot transition ${this.id} from ${this._status} to ${next}`);
    }
    this._status = next;
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = props[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidTransactionError(`${field} is required`);
      }
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidTransactionError(`unknown kind ${String(props.kind)}`);
    }
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())) {
      throw new InvalidTransactionError(
        props.kind === WagerTransactionKind.Loss ? 'amount must not be negative' : 'amount must be positive',
      );
    }

    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    const reference = props.referenceExternalTransactionId;
    if (needsReference && (typeof reference !== 'string' || reference.trim() === '')) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidTransactionError('BET cannot carry a reference');
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidTransactionError('a transaction cannot reference itself');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      computePayloadHash({ ...props, referenceExternalTransactionId: reference }),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      new Date(props.createdAt),
      S.Pending,
    );
  }
}
