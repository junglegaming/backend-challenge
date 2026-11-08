import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000006_reference_retry extends Migration {
  override up(): void {
    this.addSql(`
      alter table wagering_transactions
        add column reference_retry_count integer not null default 0,
        add column reference_next_attempt_at timestamptz not null default now(),
        add constraint wagering_transactions_reference_retry_count_ck check (reference_retry_count >= 0);
    `);
    this.addSql(`
      create index wagering_transactions_reference_due_idx
        on wagering_transactions (reference_next_attempt_at, id) where status = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql('drop index wagering_transactions_reference_due_idx;');
    this.addSql(`
      alter table wagering_transactions drop constraint wagering_transactions_reference_retry_count_ck,
        drop column reference_retry_count, drop column reference_next_attempt_at;
    `);
  }
}
