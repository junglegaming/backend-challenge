import {
  InvalidTransactionInputError,
  InvalidTransactionStateError,
} from "../../shared/domain/domain-error";
import { Money } from "../../shared/domain/money";
import { FailureCode } from "./failure-code";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}
export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
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
  observedBalance: Money | null;
  referenceDeadlineAt?: Date;
  nextAttemptAt?: Date;
  referenceAttempts: number;
}

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}

  static create(
    props: CreateWagerTransactionProps,
    source: "external" | "internal" = "external",
  ): WagerTransaction {
    const invalid = () => {
      throw new InvalidTransactionInputError("Invalid transaction input");
    };
    if (!Object.values(WagerTransactionKind).includes(props.kind) || props.money.isNegative())
      invalid();
    if (typeof props.providerId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(props.providerId))
      invalid();
    if ((props.kind === WagerTransactionKind.Opening) !== (props.providerId === "internal"))
      invalid();
    if (props.kind === WagerTransactionKind.Opening && source !== "internal") invalid();
    for (const identifier of [
      props.playerId,
      props.externalTransactionId,
      props.roundId,
      props.gameId,
    ]) {
      if (typeof identifier !== "string" || !/^[!-~]{1,128}$/.test(identifier)) invalid();
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.walletId))
      invalid();
    if (
      typeof props.idempotencyKey !== "string" ||
      !/^[\x20-\x7e]{1,255}$/.test(props.idempotencyKey) ||
      !/^[a-f0-9]{64}$/.test(props.payloadHash)
    )
      invalid();
    const reference = props.referenceExternalTransactionId;
    if (
      reference !== undefined &&
      (typeof reference !== "string" || !/^[!-~]{1,128}$/.test(reference))
    )
      invalid();
    if (
      [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(props.kind) &&
      reference === undefined
    )
      invalid();
    if (
      [WagerTransactionKind.Bet, WagerTransactionKind.Opening].includes(props.kind) &&
      reference !== undefined
    )
      invalid();
    if (reference === props.externalTransactionId) invalid();
    return WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      observedBalance: null,
      referenceAttempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      ...state,
      createdAt: new Date(state.createdAt),
      processedAt: state.processedAt && new Date(state.processedAt),
      referenceDeadlineAt: state.referenceDeadlineAt && new Date(state.referenceDeadlineAt),
      nextAttemptAt: state.nextAttemptAt && new Date(state.nextAttemptAt),
    });
  }

  get id() {
    return this.state.id;
  }
  get providerId() {
    return this.state.providerId;
  }
  get externalTransactionId() {
    return this.state.externalTransactionId;
  }
  get idempotencyKey() {
    return this.state.idempotencyKey;
  }
  get payloadHash() {
    return this.state.payloadHash;
  }
  get walletId() {
    return this.state.walletId;
  }
  get playerId() {
    return this.state.playerId;
  }
  get roundId() {
    return this.state.roundId;
  }
  get gameId() {
    return this.state.gameId;
  }
  get kind() {
    return this.state.kind;
  }
  get money() {
    return this.state.money;
  }
  get referenceExternalTransactionId() {
    return this.state.referenceExternalTransactionId;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }
  get status() {
    return this.state.status;
  }
  get referenceTransactionId() {
    return this.state.referenceTransactionId;
  }
  get failureCode() {
    return this.state.failureCode;
  }
  get processedAt() {
    return this.state.processedAt && new Date(this.state.processedAt);
  }
  get observedBalance() {
    return this.state.observedBalance;
  }
  get referenceDeadlineAt() {
    return this.state.referenceDeadlineAt && new Date(this.state.referenceDeadlineAt);
  }
  get nextAttemptAt() {
    return this.state.nextAttemptAt && new Date(this.state.nextAttemptAt);
  }
  get referenceAttempts() {
    return this.state.referenceAttempts;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this.status);
  }
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }
  requiresReference(): boolean {
    return [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(this.kind);
  }
  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  markProcessed(referenceId: string | undefined, at: Date, balance: Money): void {
    this.assertMutable();
    this.state.status = WagerTransactionStatus.Processed;
    this.state.referenceTransactionId = referenceId;
    this.state.processedAt = new Date(at);
    this.state.observedBalance = balance;
  }

  markPendingReference(at: Date, balance: Money, ttlMs = 86_400_000, retryJitter = 0): void {
    this.assertMutable();
    this.state.status = WagerTransactionStatus.PendingReference;
    this.state.observedBalance = balance;
    this.state.referenceDeadlineAt ??= new Date(at.getTime() + ttlMs);
    this.scheduleReferenceRetry(at, 5000, 300_000, retryJitter);
  }

  scheduleReferenceRetry(at: Date, baseMs = 5000, maxMs = 300_000, jitter = 0): void {
    this.assertMutable();
    this.state.nextAttemptAt = new Date(
      at.getTime() +
        Math.min(
          maxMs,
          Math.floor(baseMs * 2 ** Math.min(this.referenceAttempts, 30) * (1 + jitter)),
        ),
    );
    this.state.referenceAttempts += 1;
  }

  reject(code: FailureCode, at: Date, balance: Money | null, referenceId?: string): void {
    this.assertMutable();
    if (code === FailureCode.PermanentProcessingError)
      throw new InvalidTransactionStateError("Permanent errors must fail");
    this.finish(WagerTransactionStatus.Rejected, code, at, balance, referenceId);
  }

  fail(code: FailureCode, at: Date, balance: Money | null): void {
    this.assertMutable();
    if (code !== FailureCode.PermanentProcessingError)
      throw new InvalidTransactionStateError("Only permanent errors can fail");
    this.finish(WagerTransactionStatus.Failed, code, at, balance, this.referenceTransactionId);
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (
      [
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Opening,
      ].includes(this.kind)
    )
      return LedgerDirection.Credit;
    if (
      this.kind === WagerTransactionKind.Rollback &&
      reference &&
      [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(
        reference.kind,
      )
    ) {
      return reference.ledgerDirectionFor() === LedgerDirection.Debit
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
    }
    throw new InvalidTransactionInputError("No ledger direction for this transaction");
  }

  private finish(
    status: WagerTransactionStatus,
    code: FailureCode,
    at: Date,
    balance: Money | null,
    referenceId?: string,
  ) {
    this.state.status = status;
    this.state.failureCode = code;
    this.state.processedAt = new Date(at);
    this.state.observedBalance = balance;
    this.state.referenceTransactionId = referenceId;
  }
  private assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError("Transaction is terminal");
  }
}
