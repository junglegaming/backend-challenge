import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { LogContext } from '../../application/log-context';
import type { StructuredLogger } from '../../application/ports';

/**
 * Keys never logged even if someone passes them by mistake: financial
 * payloads (amounts, balances) and credentials stay out of the logs; only
 * identifiers, statuses and failure codes go in.
 */
const REDACT = [
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'initialBalance',
  'payload',
  'authorization',
  'headers.authorization',
  '*.money',
  '*.amount',
  '*.balance',
  '*.payload',
];

export const createRootLogger = (level: string, instanceId: string): Logger =>
  pino({
    level,
    base: { service: 'wagering-processor', instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT, censor: '[redacted]' },
    // correlationId / messageId / transactionId / walletId / providerId from the async context
    mixin: () => ({ ...LogContext.current() }),
  });

/** Application-facing port implementation. */
export class PinoStructuredLogger implements StructuredLogger {
  constructor(private readonly logger: Logger) {}

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.logger.debug(fields ?? {}, msg);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.logger.info(fields ?? {}, msg);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.logger.warn(fields ?? {}, msg);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.logger.error(fields ?? {}, msg);
  }
}

/** Routes NestJS framework logs through the same JSON logger. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
