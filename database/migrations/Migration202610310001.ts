import { Migration } from "@mikro-orm/migrations";

export class Migration202610310001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid CONSTRAINT pk_wallets PRIMARY KEY,
        player_id text NOT NULL CONSTRAINT ck_wallets_player_length CHECK (char_length(player_id) BETWEEN 1 AND 128),
        currency char(3) NOT NULL CONSTRAINT ck_wallets_currency CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(18,2) NOT NULL CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        version integer NOT NULL DEFAULT 1 CONSTRAINT ck_wallets_version CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
      );
      CREATE TABLE wager_transactions (
        id uuid CONSTRAINT pk_wager_transactions PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CONSTRAINT ck_wager_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(18,2) NOT NULL CONSTRAINT ck_wager_amount CHECK (amount >= 0),
        currency char(3) NOT NULL CONSTRAINT ck_wager_currency CHECK (currency ~ '^[A-Z]{3}$'),
        status text NOT NULL CONSTRAINT ck_wager_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text,
        reference_transaction_id uuid CONSTRAINT fk_wager_reference REFERENCES wager_transactions (id),
        failure_code text,
        observed_balance numeric(18,2) CONSTRAINT ck_wager_observed_non_negative CHECK (observed_balance >= 0),
        observed_currency char(3),
        reference_deadline_at timestamptz,
        next_reference_attempt_at timestamptz,
        reference_attempts integer NOT NULL DEFAULT 0 CONSTRAINT ck_wager_reference_attempts CHECK (reference_attempts >= 0),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT uq_wager_transactions_provider_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_wager_transactions_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_transactions_id_wallet UNIQUE (id, wallet_id),
        CONSTRAINT ck_wager_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT ck_wager_reference_required CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_reference_forbidden CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT ck_wager_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_processed CHECK (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND observed_balance IS NOT NULL)),
        CONSTRAINT ck_wager_positive_when_moving CHECK (status <> 'PROCESSED' OR kind = 'LOSS' OR amount > 0),
        CONSTRAINT ck_wager_observed_pair CHECK ((observed_balance IS NULL) = (observed_currency IS NULL)),
        CONSTRAINT ck_wager_pending_schedule CHECK (status <> 'PENDING_REFERENCE' OR (reference_deadline_at IS NOT NULL AND next_reference_attempt_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX uq_wager_single_processed_reversal ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX ix_wager_pending_due ON wager_transactions (next_reference_attempt_at) WHERE status = 'PENDING_REFERENCE';
      CREATE TABLE wallet_ledger_entries (
        id uuid CONSTRAINT pk_wallet_ledger_entries PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        wallet_version integer NOT NULL CONSTRAINT ck_ledger_version CHECK (wallet_version >= 1),
        direction text NOT NULL CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(18,2) NOT NULL CONSTRAINT ck_ledger_amount CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(18,2) NOT NULL CONSTRAINT ck_ledger_before_non_negative CHECK (balance_before >= 0),
        balance_after numeric(18,2) NOT NULL CONSTRAINT ck_ledger_after_non_negative CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL,
        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT fk_ledger_transaction_wallet FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount))
      );
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
      CREATE TABLE outbox_messages (
        id uuid CONSTRAINT pk_outbox_messages PRIMARY KEY,
        aggregate_id text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz
      );
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
      CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Ledger entries are immutable' USING ERRCODE = '23514', CONSTRAINT = 'ck_ledger_immutable'; END;
      $$;
      CREATE TRIGGER ledger_immutable_rows BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
      CREATE TRIGGER ledger_immutable_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();
      CREATE FUNCTION protect_wager_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP <> 'UPDATE' THEN
            RAISE EXCEPTION 'Transactions cannot be removed' USING ERRCODE = '23514', CONSTRAINT = 'ck_wager_immutable';
          END IF;
          IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
            RAISE EXCEPTION 'Terminal transactions are immutable' USING ERRCODE = '23514', CONSTRAINT = 'ck_wager_terminal';
          END IF;
          IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.reference_deadline_at, NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.reference_deadline_at, OLD.created_at) THEN
            RAISE EXCEPTION 'Transaction business fields are immutable' USING ERRCODE = '23514', CONSTRAINT = 'ck_wager_business_immutable';
          END IF;
          RETURN NEW;
        END;
      $$;
      CREATE TRIGGER wager_protect_updates BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_wager_transaction();
      CREATE TRIGGER wager_protect_truncate BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION protect_wager_transaction();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets;
      DROP FUNCTION prevent_ledger_mutation();
      DROP FUNCTION protect_wager_transaction();
    `);
  }
}
