import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { ApplicationError, type ApplicationErrorKind } from "../../shared/application/errors";
import { type AppLogger, logContext } from "../../shared/application/observability";

/**
 * Single error contract for every endpoint: { code, message, details?, correlationId }.
 *
 *   400 VALIDATION   — malformed payload; do not resend unchanged
 *   404 NOT_FOUND    — unknown resource
 *   409 CONFLICT     — idempotency conflict / duplicate wallet; do not resend
 *   422 UNPROCESSABLE— valid payload that can never be applied (e.g. unknown wallet)
 *   503 TRANSIENT    — infrastructure hiccup; safe to resend after Retry-After
 *   500              — unexpected; logged with stack, details never leaked
 */
const STATUS: Record<ApplicationErrorKind, number> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  UNPROCESSABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  TRANSIENT: HttpStatus.SERVICE_UNAVAILABLE,
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = logContext.get().correlationId;

    if (exception instanceof ApplicationError) {
      const status = STATUS[exception.kind];
      if (exception.kind === "TRANSIENT") res.setHeader("Retry-After", "1");
      const level = exception.kind === "TRANSIENT" || exception.kind === "CONFLICT" ? "warn" : "info";
      this.logger[level]({ code: exception.code, status }, exception.message);
      res.status(status).json({
        code: exception.code,
        message: exception.message,
        details: exception.details,
        correlationId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Body parser errors (malformed JSON, payload too large) surface as HttpExceptions or typed errors below.
      res.status(status).json({ code: httpCode(status), message: exception.message, correlationId });
      return;
    }

    const bodyParserStatus = bodyParserError(exception);
    if (bodyParserStatus) {
      res.status(bodyParserStatus).json({
        code: bodyParserStatus === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
        message: bodyParserStatus === 413 ? "payload too large" : "malformed JSON body",
        correlationId,
      });
      return;
    }

    this.logger.error({ err: exception }, "unhandled error");
    res.status(500).json({ code: "INTERNAL_ERROR", message: "internal error", correlationId });
  }
}

function httpCode(status: number): string {
  if (status === 404) return "NOT_FOUND";
  if (status === 403) return "FORBIDDEN";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status >= 500) return "INTERNAL_ERROR";
  return "VALIDATION_ERROR";
}

function bodyParserError(e: unknown): number | undefined {
  if (!e || typeof e !== "object") return undefined;
  const type = (e as { type?: unknown }).type;
  if (type === "entity.parse.failed") return 400;
  if (type === "entity.too.large") return 413;
  return undefined;
}
