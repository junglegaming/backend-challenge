/**
 * Classification of database errors into "retry the whole transaction" vs "propagate".
 * Works on raw `pg` errors and on MikroORM DriverExceptions (which keep `code` = SQLSTATE).
 */
const TRANSIENT_SQLSTATES: Record<string, string> = {
  "40001": "serialization_failure",
  "40P01": "deadlock_detected",
  "55P03": "lock_not_available",
  "57014": "query_canceled",
  "57P01": "admin_shutdown",
  "57P02": "crash_shutdown",
  "57P03": "cannot_connect_now",
  "53300": "too_many_connections",
  "53200": "out_of_memory",
};

const TRANSIENT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection refused/i,
];

/** Lock contention reasons, counted separately as "lock conflicts". */
export const LOCK_CONFLICT_REASONS = new Set([
  "deadlock_detected",
  "lock_not_available",
  "serialization_failure",
]);

interface ErrorLike {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

function walk(error: unknown, visit: (e: ErrorLike) => string | undefined): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const found = visit(current as ErrorLike);
    if (found !== undefined) return found;
    current = (current as ErrorLike).cause;
  }
  return undefined;
}

export function sqlStateOf(error: unknown): string | undefined {
  return walk(error, (e) => {
    if (typeof e.sqlState === "string") return e.sqlState;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    return undefined;
  });
}

export function constraintOf(error: unknown): string | undefined {
  return walk(error, (e) => (typeof e.constraint === "string" ? e.constraint : undefined));
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (sqlStateOf(error) !== "23505") return false;
  if (!constraint) return true;
  const found = constraintOf(error);
  if (found !== undefined) return found === constraint;
  return (
    walk(error, (e) =>
      typeof e.message === "string" && e.message.includes(constraint) ? "y" : undefined,
    ) === "y"
  );
}

/** Returns a reason when the error is worth retrying the whole transaction, undefined otherwise. */
export function transientReason(error: unknown): string | undefined {
  const state = sqlStateOf(error);
  if (state && TRANSIENT_SQLSTATES[state]) return TRANSIENT_SQLSTATES[state];
  if (state?.startsWith("08")) return "connection_exception";
  return walk(error, (e) => {
    if (typeof e.code === "string" && TRANSIENT_NODE_CODES.has(e.code)) return e.code.toLowerCase();
    if (typeof e.message === "string" && TRANSIENT_MESSAGES.some((re) => re.test(e.message as string))) {
      return "connection_lost";
    }
    return undefined;
  });
}
