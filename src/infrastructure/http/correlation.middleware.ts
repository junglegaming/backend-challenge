import type { NextFunction, Request, Response } from "express";
import { type AppLogger, logContext } from "../../shared/application/observability";

const CORRELATION_HEADER = "x-correlation-id";
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Opens the async log context for the request (correlationId from X-Correlation-Id or a fresh UUIDv7),
 * echoes it in the response and writes one access-log line on completion. No bodies are logged.
 */
export function correlationMiddleware(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && VALID_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
    res.setHeader("X-Correlation-Id", correlationId);
    const started = performance.now();
    logContext.run({ correlationId, channel: "http" }, () => {
      res.on("finish", () => {
        if (req.path.startsWith("/health") || req.path === "/metrics") return;
        logger.info(
          {
            correlationId,
            method: req.method,
            path: req.route?.path ?? req.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
          },
          "http request",
        );
      });
      next();
    });
  };
}
