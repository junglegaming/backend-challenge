import {
  ApplicationError,
  IntegrityViolationError,
  TransientInfrastructureError,
  type TransientReason,
  UniqueViolationError,
} from '../../application/errors';
import { DomainError } from '../../domain/errors';

interface PgLikeError {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  message?: unknown;
  previous?: unknown;
  cause?: unknown;
}

const TRANSIENT_SQLSTATE: Record<string, TransientReason> = {
  '40001': 'serialization',
  '40P01': 'deadlock',
  '55P03': 'lock-timeout',
  '57014': 'timeout', // statement_timeout / query cancelled
  '57P01': 'connection', // admin shutdown
  '57P02': 'connection',
  '57P03': 'connection', // cannot connect now (starting up)
  '53300': 'connection', // too many connections
};

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);
const NETWORK_MESSAGES = [/connection terminated/i, /timeout acquiring a connection/i, /connection.*(closed|ended)/i, /pool.*(destroyed|ended)/i];

/** Walks MikroORM / knex / pg wrappers until it finds the driver error. */
const chain = (error: unknown): PgLikeError[] => {
  const out: PgLikeError[] = [];
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const e = current as PgLikeError;
    out.push(e);
    current = e.previous ?? e.cause;
  }
  return out;
};

/**
 * Maps driver errors into the application taxonomy:
 *  - lock / deadlock / serialization / connection problems -> TransientInfrastructureError
 *  - unique violation -> UniqueViolationError (transient: re-running resolves the race)
 *  - any other integrity violation (CHECK, FK, our triggers) -> IntegrityViolationError
 */
export const translateDatabaseError = (error: unknown): unknown => {
  if (error instanceof ApplicationError || error instanceof DomainError) return error;

  for (const e of chain(error)) {
    const state = typeof e.sqlState === 'string' ? e.sqlState : typeof e.code === 'string' ? e.code : undefined;
    if (!state) continue;
    if (state === '23505') {
      return new UniqueViolationError(typeof e.constraint === 'string' ? e.constraint : undefined, { cause: error });
    }
    const reason = TRANSIENT_SQLSTATE[state] ?? (state.startsWith('08') ? 'connection' : undefined);
    if (reason) {
      return new TransientInfrastructureError(reason, `Database temporarily unavailable (${state})`, { cause: error });
    }
    if (NETWORK_CODES.has(state)) {
      return new TransientInfrastructureError('connection', `Database unreachable (${state})`, { cause: error });
    }
    if (state.startsWith('23') || state === 'P0001') {
      return new IntegrityViolationError(String(e.message ?? 'integrity violation'), { sqlState: state });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_MESSAGES.some((pattern) => pattern.test(message))) {
    return new TransientInfrastructureError('connection', 'Database unreachable', { cause: error });
  }
  return error;
};
