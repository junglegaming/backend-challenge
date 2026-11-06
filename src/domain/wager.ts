import { DomainError, Money } from './money';
export enum Kind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}
export enum Status {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}
export type FailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_INVALID'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'CURRENCY_MISMATCH'
  | 'WALLET_MISMATCH';
export type WagerTransactionState = {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
};
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: Kind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private state: Status,
    private refId?: string,
    private failure?: FailureCode,
    private doneAt?: Date,
  ) {}
  static create(
    p: Omit<
      WagerTransaction,
      | 'state'
      | 'refId'
      | 'failure'
      | 'doneAt'
      | 'status'
      | 'failureCode'
      | 'referenceTransactionId'
      | 'processedAt'
      | 'isTerminal'
      | 'affectsBalance'
      | 'requiresReference'
      | 'matchesPayload'
      | 'markProcessed'
      | 'markPendingReference'
      | 'reject'
      | 'fail'
      | 'ledgerDirectionFor'
    >,
  ): WagerTransaction {
    if (p.kind === Kind.Opening) throw new DomainError('INTERNAL_KIND', 'OPENING is internal');
    if (
      (p.kind === Kind.Refund || p.kind === Kind.Rollback) !==
      Boolean(p.referenceExternalTransactionId)
    )
      throw new DomainError('INVALID_REFERENCE', 'Reference requirement does not match kind');
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.createdAt,
      Status.Pending,
    );
  }
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
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
    );
  }
  get status() {
    return this.state;
  }
  get referenceTransactionId() {
    return this.refId;
  }
  get failureCode() {
    return this.failure;
  }
  get processedAt() {
    return this.doneAt;
  }
  isTerminal() {
    return [Status.Processed, Status.Rejected, Status.Failed].includes(this.state);
  }
  affectsBalance() {
    return this.kind !== Kind.Loss;
  }
  requiresReference() {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }
  matchesPayload(h: string) {
    return this.payloadHash === h;
  }
  private active() {
    if (this.isTerminal())
      throw new DomainError('INVALID_TRANSACTION_STATE', 'Terminal transaction cannot transition');
  }
  markProcessed(ref: string | undefined, at: Date) {
    this.active();
    this.state = Status.Processed;
    this.refId = ref;
    this.doneAt = at;
  }
  markPendingReference() {
    this.active();
    this.state = Status.PendingReference;
  }
  reject(code: FailureCode) {
    this.active();
    this.state = Status.Rejected;
    this.failure = code;
  }
  fail(code: FailureCode) {
    this.active();
    this.state = Status.Failed;
    this.failure = code;
  }
}
