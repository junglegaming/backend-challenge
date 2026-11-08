import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000008_trace_context extends Migration {
  override up(): void {
    this.addSql('alter table outbox_messages add column trace_context jsonb;');
    this.addSql('alter table wagering_transactions add column trace_context jsonb;');
  }

  override down(): void {
    this.addSql('alter table wagering_transactions drop column trace_context;');
    this.addSql('alter table outbox_messages drop column trace_context;');
  }
}
