export function retryDelaySeconds(attempt: number, baseSeconds = 0, maxSeconds = 300): number {
  if (baseSeconds > 0) return Math.min(baseSeconds, maxSeconds);
  return Math.min(maxSeconds, 2 ** Math.max(0, attempt - 1));
}
