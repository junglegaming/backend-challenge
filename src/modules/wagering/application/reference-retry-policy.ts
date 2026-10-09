import { type BackoffPolicy, computeBackoffMs } from "../../../shared/domain/backoff";

/**
 * Retry budget for PENDING_REFERENCE transactions. Defaults: 2s base, x2 per attempt, 5 min cap, 10 attempts
 * (≈ 35 min end to end). Providers normally send the referenced operation within seconds; a longer window
 * keeps money in limbo and delays a definitive answer (REFERENCE_NOT_FOUND) to the provider.
 */
export class ReferenceRetryPolicy {
  constructor(
    private readonly backoff: BackoffPolicy,
    readonly maxAttempts: number,
    private readonly random: () => number = Math.random,
  ) {}

  /** Time of the next attempt after `attempt` failed lookups (0 = parked for the first time). */
  nextRetryAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + computeBackoffMs(attempt, this.backoff, this.random));
  }

  /** True when the attempt about to run is the last one allowed. */
  isExhausted(attemptsSoFar: number): boolean {
    return attemptsSoFar + 1 >= this.maxAttempts;
  }
}

export const REFERENCE_RETRY_POLICY = Symbol("REFERENCE_RETRY_POLICY");
