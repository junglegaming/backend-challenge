import type { Money } from '../../domain/shared/money';
import { InvalidRequestError } from '../errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** numeric(20,2) holds at most 18 integer digits. */
const STORABLE_AMOUNT_RE = /^\d{1,18}\.\d{2}$/;

export function assertUuid(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new InvalidRequestError(`${field} must be a UUID`);
  }
}

export function assertStorableMoney(field: string, money: Money): void {
  if (!STORABLE_AMOUNT_RE.test(money.toString())) {
    throw new InvalidRequestError(`${field} exceeds the supported range (18 integer digits)`);
  }
}
