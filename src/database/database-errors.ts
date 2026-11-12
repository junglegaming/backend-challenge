import { DriverException, UniqueConstraintViolationException } from "@mikro-orm/core";
import { TransientError } from "../domain/shared/errors";

/**
 * PostgreSQL SQLSTATE codes that mean "try again later" rather than "your
 * request is wrong": lock/statement timeouts, deadlocks, serialization
 * failures, admin shutdown and connection problems.
 */
const TRANSIENT_SQLSTATES = new Set([
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
]);

const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);

/** Extracts the SQLSTATE / errno code from a MikroORM or pg error. */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const candidate = (error as { code?: unknown; sqlState?: unknown }).sqlState ?? (error as { code?: unknown }).code;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && (TRANSIENT_SQLSTATES.has(code) || code.startsWith("08") || TRANSIENT_NETWORK_CODES.has(code))) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(message);
}

export function isLockConflict(error: unknown): boolean {
  const code = errorCode(error);
  return code === "55P03" || code === "40P01";
}

/** True when the error is a unique violation of the given constraint/index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof UniqueConstraintViolationException) && errorCode(error) !== "23505") {
    return false;
  }
  if (!constraint) {
    return true;
  }
  const errObj = error as { message?: string; constraint?: string };
  const detail =
    error instanceof DriverException
      ? `${error.message} ${errObj.constraint ?? ""}`
      : `${errObj?.message ?? ""} ${errObj?.constraint ?? ""} ${String(error)}`;
  return detail.includes(constraint);
}

/**
 * Converts infrastructure failures into TransientError (retryable). Anything
 * else is returned untouched so callers can still handle specific cases.
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof TransientError || !isTransientDatabaseError(error)) {
    return error;
  }
  return new TransientError("Database temporarily unavailable", error);
}

