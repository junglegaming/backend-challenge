import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1710000000000 implements MigrationInterface {
  name = 'InitialSchema1710000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version bigint NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL,
        reference_external_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        failure_code text,
        resulting_balance numeric(20, 2),
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        UNIQUE (provider_id, external_transaction_id)
      );

      CREATE INDEX wager_pending_reference_idx
        ON wager_transactions(created_at)
        WHERE status = 'PENDING_REFERENCE';

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL,
        UNIQUE (wallet_id, transaction_id),
        CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );

      CREATE FUNCTION prevent_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'ledger entries are immutable';
      END;
      $$;

      CREATE TRIGGER wallet_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

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

      CREATE TABLE inbox_messages (
        message_id text NOT NULL,
        consumer_name text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        locked_until timestamptz
      );

      CREATE INDEX outbox_due_idx
        ON outbox_messages(next_attempt_at, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS
        outbox_messages,
        inbox_messages,
        wallet_ledger_entries,
        wager_transactions,
        wallets
      CASCADE;

      DROP FUNCTION IF EXISTS prevent_ledger_mutation();
      DROP FUNCTION IF EXISTS assert_wallet_ledger_balance();
    `);
  }
}
