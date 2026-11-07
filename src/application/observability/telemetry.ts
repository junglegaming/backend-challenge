export interface Telemetry {
  transaction(status: string): void;
  duplicate(source: 'inbox' | 'transaction'): void;
  retry(source: 'sqs' | 'outbox' | 'reference'): void;
  lockConflict(): void;
  latency(operation: 'http' | 'sqs' | 'transaction', seconds: number): void;
}

export const NOOP_TELEMETRY: Telemetry = {
  transaction() {}, duplicate() {}, retry() {}, lockConflict() {}, latency() {},
};
