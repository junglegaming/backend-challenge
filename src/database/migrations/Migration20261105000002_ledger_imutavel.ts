import { Migration } from '@mikro-orm/migrations';

/** Ledger append-only: UPDATE e DELETE são rejeitados pelo próprio banco. */
export class Migration20261105000002_ledger_imutavel extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries é imutável: % não permitido', TG_OP
          USING ERRCODE = 'check_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_entries_append_only ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS ledger_append_only()');
  }
}
