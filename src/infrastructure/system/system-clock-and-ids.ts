import { randomUUIDv7 } from 'bun';
import type { Clock, IdGenerator } from '../../application/ports/clock-and-ids.port';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: time-ordered, index-friendly primary keys. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return randomUUIDv7();
  }
}
