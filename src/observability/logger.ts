import type { LoggerService } from "@nestjs/common";
import pino from "pino";
import { currentContext } from "./context";

/**
 * Structured JSON logger.
 *
 * The `mixin` merges the current request/message context into every line, so
 * correlationId, messageId, transactionId, walletId and providerId show up
 * automatically without being passed around by hand.
 *
 * `redact` is a safety net: even if someone logs a payload by mistake,
 * monetary values and credentials are masked.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "wagering-processor", instance: process.env.INSTANCE_ID ?? `pid-${process.pid}` },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  messageKey: "message",
  mixin: () => ({ ...currentContext() }),
  redact: {
    paths: [
      "*.money",
      "*.amount",
      "*.balance",
      "*.initialBalance",
      "*.password",
      "*.authorization",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
});

/** Serializes errors without leaking payloads; stack only for unexpected errors. */
export function errorFields(error: unknown, includeStack = false): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorCode: (error as { code?: unknown }).code,
      errorMessage: error.message,
      ...(includeStack ? { stack: error.stack } : {}),
    };
  }
  return { errorMessage: String(error) };
}

/** Routes NestJS internal logs through the same JSON logger. */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    logger.info({ nestContext: context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    logger.error({ nestContext: context, stack: trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    logger.warn({ nestContext: context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    logger.debug({ nestContext: context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    logger.trace({ nestContext: context }, String(message));
  }
}

