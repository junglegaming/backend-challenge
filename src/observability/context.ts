import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Identifiers attached to every log line emitted while handling one request,
 * SQS message or background job. Only identifiers: never amounts or payloads.
 */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  channel?: "http" | "sqs" | "worker";
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with a fresh context (inherits nothing from the caller). */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Adds identifiers to the current context as soon as they become known. */
export function enrichContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, stripUndefined(fields));
  }
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

function stripUndefined(fields: LogContext): LogContext {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as LogContext;
}

