export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** 0..1 — fraction of the computed delay that is randomised ("equal jitter"). */
  jitter: number;
}

/**
 * Exponential backoff with bounded jitter: delay = min(max, base * 2^attempt), then
 * randomised within [delay*(1-jitter), delay]. `random` is injectable for deterministic tests.
 */
export function computeBackoffMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt));
  const spread = exp * Math.min(Math.max(policy.jitter, 0), 1);
  return Math.round(exp - spread * random());
}
