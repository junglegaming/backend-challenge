import { v7 as uuidv7 } from 'uuid';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** time-ordered UUIDv7, index friendly */
  next(): string;
}

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');

export const systemClock: Clock = { now: () => new Date() };
export const uuidV7Generator: IdGenerator = { next: () => uuidv7() };
