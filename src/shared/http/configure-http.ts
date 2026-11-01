import { randomUUID } from "node:crypto";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  ValidationPipe,
} from "@nestjs/common";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  TransientProcessingError,
  WalletAlreadyExistsError,
} from "../../wagering/application/errors";
import { DomainError } from "../domain/domain-error";
import { sqlErrorFields } from "../infrastructure/sql-error-classifier";
import { ApiError, HttpReply, HttpRequest } from "./http-contract";

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const reply = http.getResponse<HttpReply>();
    let mapped: ApiError;
    if (error instanceof ApiError) mapped = error;
    else if (error instanceof WalletAlreadyExistsError)
      mapped = new ApiError(
        409,
        "WALLET_ALREADY_EXISTS",
        "A wallet already exists for this player and currency",
      );
    else if (error instanceof DomainError)
      mapped = new ApiError(400, "VALIDATION_FAILED", "The request contains invalid fields");
    else if (error instanceof TransientProcessingError || sqlErrorFields(error).code)
      mapped = new ApiError(
        503,
        "TEMPORARILY_UNAVAILABLE",
        "The service is temporarily unavailable",
      );
    else if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      error.statusCode === 400
    )
      mapped = new ApiError(400, "VALIDATION_FAILED", "The request is invalid");
    else if (error instanceof HttpException) {
      const status = error.getStatus();
      mapped = new ApiError(
        status,
        status === 404
          ? "NOT_FOUND"
          : status === 503
            ? "TEMPORARILY_UNAVAILABLE"
            : "VALIDATION_FAILED",
        status === 404
          ? "Resource not found"
          : status === 503
            ? "The service is temporarily unavailable"
            : "The request is invalid",
      );
    } else
      mapped = new ApiError(
        503,
        "TEMPORARILY_UNAVAILABLE",
        "The service is temporarily unavailable",
      );
    if (mapped.getStatus() === 401) reply.header("WWW-Authenticate", "Bearer");
    if (mapped.getStatus() === 503) reply.header("Retry-After", "1");
    return reply.status(mapped.getStatus()).send({
      error: {
        code: mapped.code,
        message: mapped.message,
        correlationId: request.correlationId,
        details: mapped.details,
      },
    });
  }
}

export function configureHttp(app: NestFastifyApplication) {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRequest", async (request, reply) => {
      const supplied = request.headers["x-correlation-id"];
      const context = request as typeof request & HttpRequest;
      context.correlationId =
        typeof supplied === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
          ? supplied
          : randomUUID();
      reply.header("X-Correlation-Id", context.correlationId);
    });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      exceptionFactory: () =>
        new ApiError(400, "VALIDATION_FAILED", "The request contains invalid fields"),
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
}
