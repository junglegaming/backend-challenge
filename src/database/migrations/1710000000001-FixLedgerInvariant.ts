import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixLedgerInvariant1710000000001 implements MigrationInterface {
  name = 'FixLedgerInvariant1710000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS wallet_balance_matches_ledger ON wallets;
      DROP TRIGGER IF EXISTS ledger_keeps_wallet_balance ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS assert_wallet_ledger_balance();

      CREATE FUNCTION assert_wallet_ledger_balance()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        target_id uuid;
        wallet_total numeric(20, 2);
        ledger_total numeric(20, 2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target_id := NEW.id;
        ELSE
          target_id := NEW.wallet_id;
        END IF;

        SELECT balance INTO wallet_total
        FROM wallets
        WHERE id = target_id;

        SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
        INTO ledger_total
        FROM wallet_ledger_entries
        WHERE wallet_id = target_id;

        IF wallet_total IS DISTINCT FROM ledger_total THEN
          RAISE EXCEPTION 'wallet balance does not match immutable ledger'
            USING ERRCODE = '23514';
        END IF;

        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER wallet_balance_matches_ledger
      AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_balance();

      CREATE CONSTRAINT TRIGGER ledger_keeps_wallet_balance
      AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_balance();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS wallet_balance_matches_ledger ON wallets;
      DROP TRIGGER IF EXISTS ledger_keeps_wallet_balance ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS assert_wallet_ledger_balance();

      CREATE FUNCTION assert_wallet_ledger_balance()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        target_id uuid;
        wallet_total numeric(20, 2);
        ledger_total numeric(20, 2);
      BEGIN
        target_id := COALESCE(
          (to_jsonb(NEW) ->> 'id')::uuid,
          (to_jsonb(NEW) ->> 'wallet_id')::uuid
        );

        SELECT balance INTO wallet_total
        FROM wallets
        WHERE id = target_id;

        SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
        INTO ledger_total
        FROM wallet_ledger_entries
        WHERE wallet_id = target_id;

        IF wallet_total IS DISTINCT FROM ledger_total THEN
          RAISE EXCEPTION 'wallet balance does not match immutable ledger'
            USING ERRCODE = '23514';
        END IF;

        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER wallet_balance_matches_ledger
      AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_balance();

      CREATE CONSTRAINT TRIGGER ledger_keeps_wallet_balance
      AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_balance();
    `);
  }
}
