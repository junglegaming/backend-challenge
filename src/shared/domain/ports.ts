/** Time source. Injected so tests and backoff calculations are deterministic. */
export interface Clock {
  now(): Date;
}

/** Identifier source (UUIDv7 in production: time-ordered, index friendly). */
export interface IdGenerator {
  next(): string;
}

export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");

export const systemClock: Clock = { now: () => new Date() };
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
