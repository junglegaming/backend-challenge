import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  TransientError,
  ValidationError,
} from "../domain/shared/errors";
import { currentContext } from "../observability/context";
import { errorFields, logger } from "../observability/logger";

/**
 * Maps domain, application and infrastructure errors to deterministic HTTP
 * status codes and a uniform JSON envelope with `correlationId`.
 *
 * Status code contract:
 *  - 400 Bad Request           -> malformed JSON, schema validation or invalid Money/domain input
 *  - 404 Not Found             -> wallet or transaction does not exist
 *  - 409 Conflict              -> duplicate wallet (playerId+currency) or idempotency key payload mismatch
 *  - 422 Unprocessable Entity  -> business rule rejection (returned directly by the wagering controller)
 *  - 503 Service Unavailable   -> transient database/lock/SQS failure (safe to retry)
 *  - 500 Internal Server Error -> unexpected defect (stack logged, never leaked to client)
 */
@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<{
      status: (code: number) => { json: (body: Record<string, unknown>) => void };
      setHeader?: (name: string, value: string) => void;
    }>();
    const correlationId = currentContext().correlationId;
    if (correlationId && typeof response.setHeader === "function") {
      response.setHeader("x-correlation-id", correlationId);
    }

    if (exception instanceof ValidationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          correlationId,
        },
      });
      return;
    }

    if (exception instanceof DomainError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: exception.code,
          message: exception.message,
          correlationId,
        },
      });
      return;
    }

    if (exception instanceof NotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        error: {
          code: exception.code,
          message: exception.message,
          correlationId,
        },
      });
      return;
    }

    if (exception instanceof ConflictError) {
      response.status(HttpStatus.CONFLICT).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.transactionId ? { transactionId: exception.transactionId } : {}),
          correlationId,
        },
      });
      return;
    }

    if (exception instanceof TransientError) {
      logger.warn({ ...errorFields(exception) }, "Transient infrastructure error on HTTP request");
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: true,
          correlationId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        error: {
          code: status === HttpStatus.BAD_REQUEST ? "BAD_REQUEST" : "HTTP_ERROR",
          message: exception.message,
          correlationId,
        },
      });
      return;
    }

    logger.error({ ...errorFields(exception, true) }, "Unhandled exception on HTTP request");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred",
        correlationId,
      },
    });
  }
}

