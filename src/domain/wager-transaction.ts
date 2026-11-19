import { FailureCode, InvalidTransactionStateError, ValidationError } from './errors';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

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
  resultingBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);

/**
 * Transições válidas:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 *   PROCESSED, REJECTED, FAILED são terminais.
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
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** Saldo observado no momento em que a transação foi resolvida — devolvido em replays. */
    private _resultingBalance?: Money,
    private _attempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência e de valor por kind. */
  static create(p: CreateWagerTransactionProps): WagerTransaction {
    const tx = WagerTransaction.rehydrate({ ...p, status: WagerTransactionStatus.Pending, attempts: 0 });
    if (tx.requiresReference() && !p.referenceExternalTransactionId) {
      throw new ValidationError(`${p.kind} requires referenceExternalTransactionId`);
    }
    if (tx.affectsBalance() && !p.money.isPositive()) {
      throw new ValidationError(`${p.kind} requires a positive amount`);
    }
    return tx;
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId, s.playerId,
      s.roundId, s.gameId, s.kind, s.money, s.referenceExternalTransactionId, s.createdAt, s.status,
      s.referenceTransactionId, s.failureCode, s.processedAt, s.resultingBalance, s.attempts, s.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get resultingBalance(): Money | undefined { return this._resultingBalance; }
  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultingBalance: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this.close(at, resultingBalance);
  }

  /** Referência ainda não chegou: agenda a próxima tentativa com backoff exponencial (1s, 2s, 4s...). */
  markPendingReference(now: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + 2 ** (this._attempts - 1) * 1000);
  }

  reject(code: FailureCode, at: Date, resultingBalance: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this.close(at, resultingBalance);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this.close(at, undefined);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        const original = reference?.ledgerDirectionFor();
        if (!original) throw new InvalidTransactionStateError('ROLLBACK needs a reference that moved the balance');
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  /**
   * Regras 2, 3 e 5 da seção 7 contra uma referência já encontrada e terminal.
   * Devolve o motivo da rejeição, ou undefined se a referência é válida.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    const sameScope =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency;
    if (!sameScope) return FailureCode.ReferenceMismatch;

    const allowed: WagerTransactionKind[] =
      this.kind === WagerTransactionKind.Rollback
        ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]
        : [WagerTransactionKind.Bet]; // REFUND e WIN só referenciam BET
    if (!allowed.includes(reference.kind)) return FailureCode.InvalidReferenceKind;

    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (this.requiresReference() && !reference.money.equals(this.money)) return FailureCode.AmountMismatch;
    return undefined;
  }

  private close(at: Date, resultingBalance: Money | undefined): void {
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextAttemptAt = undefined;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction ${this.id} is ${this._status} and cannot change state`);
    }
  }
}
