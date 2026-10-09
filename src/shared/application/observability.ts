import { AsyncLocalStorage } from "node:async_hooks";

/** Minimal structured logger port (pino satisfies it). Never log money amounts or full payloads. */
export interface AppLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const APP_LOGGER = Symbol("APP_LOGGER");

export type Channel = "http" | "sqs" | "worker" | "internal";

/** Business/infra metrics port; implemented with prom-client. */
export interface AppMetrics {
  transactionOutcome(labels: { kind: string; status: string; channel: Channel }): void;
  processingDuration(labels: { channel: Channel; outcome: string }, seconds: number): void;
  idempotentReplay(channel: Channel): void;
  idempotencyConflict(channel: Channel, reason: string): void;
  inboxDuplicate(): void;
  transientRetry(operation: string, reason: string): void;
  lockConflict(reason: string): void;
  sqsMessage(result: "ack" | "retry" | "dlq" | "duplicate"): void;
  outboxPublished(count: number, lagSeconds: number[]): void;
  outboxPublishFailure(): void;
  reconciliation(consistent: boolean): void;
  pendingReferenceResolution(outcome: string): void;
  submissionFailure(channel: Channel, reason: string): void;
}

export const APP_METRICS = Symbol("APP_METRICS");

export const noopMetrics: AppMetrics = {
  transactionOutcome: () => {},
  processingDuration: () => {},
  idempotentReplay: () => {},
  idempotencyConflict: () => {},
  inboxDuplicate: () => {},
  transientRetry: () => {},
  lockConflict: () => {},
  sqsMessage: () => {},
  outboxPublished: () => {},
  outboxPublishFailure: () => {},
  reconciliation: () => {},
  pendingReferenceResolution: () => {},
  submissionFailure: () => {},
};

/** Diagnostic context propagated through async calls and injected into every log line. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  channel?: Channel;
}

const storage = new AsyncLocalStorage<LogContext>();

export const logContext = {
  run<T>(ctx: LogContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...ctx }, fn);
  },
  /** Enriches the current context in place (e.g. once transactionId is known). */
  assign(fields: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
  get(): LogContext {
    return storage.getStore() ?? {};
  },
};
