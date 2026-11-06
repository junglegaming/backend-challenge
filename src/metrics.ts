export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  constructor() {
    this.counters.set('wallet_lock_conflicts_total', 0);
    this.counters.set('wagering_inbox_duplicates_total', 0);
    this.counters.set('wallet_reconciliation_mismatches_total', 0);
    this.gauges.set('wagering_dlq_messages', 0);
  }
  increment(name: string, amount = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }
  gauge(name: string, value: number) {
    this.gauges.set(name, value);
  }
  render() {
    return (
      [
        ...[...this.counters].map(([name, value]) => `${name} ${value}`),
        ...[...this.gauges].map(([name, value]) => `${name} ${value}`),
      ].join('\n') + '\n'
    );
  }
}
export const metrics = new Metrics();
