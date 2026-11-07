import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000007_correlation extends Migration {
  override up(): void {
    this.addSql('alter table wagering_transactions add column correlation_id text, add column causation_id text;');
  }

  override down(): void {
    this.addSql('alter table wagering_transactions drop column correlation_id, drop column causation_id;');
  }
}
