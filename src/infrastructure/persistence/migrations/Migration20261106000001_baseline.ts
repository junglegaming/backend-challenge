import { Migration } from '@mikro-orm/migrations';

/** Baseline: reusable trigger function that enforces append-only tables (ledger, etc.). */
export class Migration20261106000001_baseline extends Migration {
  override up(): void {
    this.addSql(`
      create function forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '% on % is forbidden: table is append-only', tg_op, tg_table_name
          using errcode = 'integrity_constraint_violation';
      end;
      $$;
    `);
  }

  override down(): void {
    this.addSql('drop function if exists forbid_mutation();');
  }
}
