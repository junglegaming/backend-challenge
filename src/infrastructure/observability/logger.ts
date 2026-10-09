import type { LoggerService } from "@nestjs/common";
import pino from "pino";
import { logContext } from "../../shared/application/observability";
import { currentTraceId } from "./tracing";

/**
 * Structured JSON logs. Every line carries the async context (correlationId, messageId, transactionId,
 * walletId, providerId, channel). Money and payload fields are redacted as defence in depth — application
 * code never logs them in the first place.
 */
export function createLogger(opts: { level: string; service: string; instanceId: string; pretty?: boolean }) {
  return pino({
    level: opts.level,
    base: { service: opts.service, instance: opts.instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...logContext.get(), traceId: currentTraceId() }),
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
    redact: {
      paths: [
        "money",
        "*.money",
        "balance",
        "*.balance",
        "amount",
        "*.amount",
        "initialBalance",
        "*.initialBalance",
        "payload",
        "*.payload",
        "body",
        "data",
        "headers.authorization",
        "*.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
    transport: opts.pretty ? { target: "pino-pretty", options: { singleLine: true } } : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** Routes Nest's internal logs through pino. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}
