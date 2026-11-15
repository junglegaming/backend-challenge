import type { FailureCode } from '../domain/failure-code';
import type { WagerTransactionStatus } from '../domain/wager-transaction';

export type Source = 'http' | 'sqs' | 'worker';

export type DuplicateKind = 'idempotency-replay' | 'inbox' | 'outbox-republish';

/** Business metrics recorded by the application layer (implemented with Prometheus). */
export interface WageringMetrics {
  transactionOutcome(status: WagerTransactionStatus, kind: string, source: Source, failureCode?: FailureCode): void;
  duplicateDetected(kind: DuplicateKind): void;
  retry(component: 'sqs' | 'outbox' | 'pending-reference' | 'unit-of-work', reason: string): void;
  lockConflict(reason: string): void;
  processingDuration(source: Source, seconds: number): void;
  reconciliationMismatch(walletId: string): void;
  walletAdmission(outcome: 'immediate' | 'queued' | 'rejected'): void;
}

export const WAGERING_METRICS = Symbol('WageringMetrics');

export interface StructuredLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const STRUCTURED_LOGGER = Symbol('StructuredLogger');

export interface PendingReferencePolicy {
  /** after this many failed resolution attempts the transaction is REJECTED */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const PENDING_REFERENCE_POLICY = Symbol('PendingReferencePolicy');
