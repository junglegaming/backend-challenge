import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function validCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function correlationId(value: unknown): string {
  return validCorrelationId(value) ? value : randomUUID();
}

export function runWithContext<T>(context: TraceContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentContext(): TraceContext | undefined {
  return storage.getStore();
}

export function updateContext(fields: Partial<TraceContext>): void {
  const context = storage.getStore();
  if (context) Object.assign(context, fields);
}

export function clearTransactionId(): void {
  const context = storage.getStore();
  if (context) delete context.transactionId;
}
