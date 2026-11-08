import { DomainError, InvariantError } from './errors';
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
  Pending = 'PENDING', // aceita, ainda não aplicada (só existe dentro da transação SQL)
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // terminal
  Rejected = 'REJECTED', // terminal
  Failed = 'FAILED', // terminal
}

/** Motivo da rejeição, estável e legível por máquina (tabela completa no ARCHITECTURE.md). */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS', // ROLLBACK deixaria saldo negativo
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  ProcessingFailed = 'PROCESSING_FAILED', // status FAILED
}

/** Tipos que um provedor pode enviar (OPENING é interno). */
export const PROVIDER_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

const { Pending: Pendente, PendingReference: AguardandoReferencia, Processed: Processada, Rejected: Rejeitada, Failed: Falhou } = WagerTransactionStatus;

/** Transições permitidas. Estados terminais não vão para lugar nenhum. */
const NEXT_STATUS: Record<WagerTransactionStatus, WagerTransactionStatus[]> = {
  [Pendente]: [Processada, Rejeitada, Falhou, AguardandoReferencia],
  [AguardandoReferencia]: [Processada, Rejeitada, Falhou, AguardandoReferencia],
  [Processada]: [],
  [Rejeitada]: [],
  [Falhou]: [],
};

/** Para quais tipos cada operação pode apontar como referência. */
const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  WIN: [WagerTransactionKind.Bet],
  LOSS: [WagerTransactionKind.Bet],
  REFUND: [WagerTransactionKind.Bet],
  ROLLBACK: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface NewWagerTransaction {
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
  referenceExternalTransactionId?: string; // id no provedor — não o id interno
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends NewWagerTransaction {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfter?: Money; // saldo observado no resultado (devolvido nos replays)
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

/**
 * Uma operação do provedor (BET, WIN, LOSS, REFUND, ROLLBACK) ou a abertura
 * interna da carteira. Guarda os dados da aposta (que nunca mudam) e o status,
 * que só muda pelas transições de `NEXT_STATUS`.
 */
export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}

  /** Nasce em PENDING. Valida as regras de cada tipo. */
  static create(props: NewWagerTransaction): WagerTransaction {
    const { kind, money, externalTransactionId, referenceExternalTransactionId: reference } = props;
    const invalid = (message: string) => new DomainError('INVALID_WAGER_TRANSACTION', message);

    if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
      throw invalid(`${kind} exige referenceExternalTransactionId`);
    }
    if (reference !== undefined && !ALLOWED_REFERENCES[kind]) throw invalid(`${kind} não aceita referência`);
    if (reference === externalTransactionId) throw invalid('uma transação não pode referenciar a si mesma');
    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw invalid(`valor de ${kind} deve ser maior que zero`);
    }

    return new WagerTransaction({ ...props, status: Pendente, referenceAttempts: 0 });
  }

  /** Reconstrói a transação lida do banco (sem revalidar). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id() { return this.state.id; }
  get providerId() { return this.state.providerId; }
  get externalTransactionId() { return this.state.externalTransactionId; }
  get idempotencyKey() { return this.state.idempotencyKey; }
  get payloadHash() { return this.state.payloadHash; }
  get walletId() { return this.state.walletId; }
  get playerId() { return this.state.playerId; }
  get roundId() { return this.state.roundId; }
  get gameId() { return this.state.gameId; }
  get kind() { return this.state.kind; }
  get money() { return this.state.money; }
  get referenceExternalTransactionId() { return this.state.referenceExternalTransactionId; }
  get correlationId() { return this.state.correlationId; }
  get createdAt() { return this.state.createdAt; }
  get status() { return this.state.status; }
  get referenceTransactionId() { return this.state.referenceTransactionId; }
  get failureCode() { return this.state.failureCode; }
  get processedAt() { return this.state.processedAt; }
  get balanceAfter() { return this.state.balanceAfter; }
  get referenceAttempts() { return this.state.referenceAttempts; }
  get nextReferenceCheckAt() { return this.state.nextReferenceCheckAt; }

  // ---- transições (sair de um estado final → InvariantError, é bug e não regra de negócio)

  /** Aplicada: guarda a referência resolvida e o saldo depois da operação. */
  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.moveTo(Processada);
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = at;
    this.state.balanceAfter = balanceAfter;
    this.state.nextReferenceCheckAt = undefined;
  }

  /** Referência ainda não chegou: agenda a próxima verificação. */
  markPendingReference(nextCheckAt: Date): void {
    if (this.status === AguardandoReferencia) this.state.referenceAttempts += 1;
    this.moveTo(AguardandoReferencia);
    this.state.nextReferenceCheckAt = nextCheckAt;
  }

  /** Recusada por regra de negócio: guarda o motivo e o saldo do momento. */
  reject(code: FailureCode, observedBalance: Money): void {
    this.moveTo(Rejeitada);
    this.state.failureCode = code;
    this.state.balanceAfter = observedBalance;
    this.state.nextReferenceCheckAt = undefined;
  }

  /** Erro técnico depois de esgotar as tentativas (só pela fila). */
  fail(code: FailureCode): void {
    this.moveTo(Falhou);
    this.state.failureCode = code;
    this.state.nextReferenceCheckAt = undefined;
  }

  // ---- consultas

  /** PROCESSED, REJECTED e FAILED são finais: não mudam mais de status. */
  isTerminal(): boolean {
    return NEXT_STATUS[this.status].length === 0;
  }

  /** LOSS só registra o resultado; todos os outros tipos mexem no saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND e ROLLBACK são reversões: sempre apontam para outra transação. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Este tipo pode apontar para uma transação do tipo informado? (ex.: REFUND → BET) */
  canReference(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCES[this.kind]?.includes(kind) ?? false;
  }

  /** Mesmo payload da requisição original? (usado no replay idempotente) */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debita; WIN/REFUND/OPENING creditam; ROLLBACK faz o inverso da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference) throw new InvariantError('ROLLBACK precisa da transação referenciada');
      const referenceDebited = reference.ledgerDirectionFor() === LedgerDirection.Debit;
      return referenceDebited ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    if (this.kind === WagerTransactionKind.Loss) throw new InvariantError('LOSS não movimenta saldo');
    return LedgerDirection.Credit;
  }

  private moveTo(next: WagerTransactionStatus): void {
    if (!NEXT_STATUS[this.status].includes(next)) {
      throw new InvariantError(`transição inválida na transação ${this.id}: ${this.status} -> ${next}`);
    }
    this.state.status = next;
  }
}
