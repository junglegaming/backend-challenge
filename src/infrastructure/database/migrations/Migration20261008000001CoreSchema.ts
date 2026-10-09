import { Migration } from "@mikro-orm/migrations";

/**
 * Core financial schema. Every guarantee from section 6 is enforced here, not only in application code:
 *  - uniqueness: one wallet per (player, currency); idempotency key; (provider, externalId); single reversal;
 *    one ledger line per (transaction, wallet); one ledger line per (wallet, version);
 *  - non-negativity: CHECKs on balances and amounts;
 *  - immutability: ledger is append-only (trigger + revoked privileges); terminal transactions are frozen;
 *  - consistency: deferred constraint triggers tie wallets.version/balance to the ledger chain at COMMIT.
 */
export class Migration20261008000001CoreSchema extends Migration {
  override name = "Migration20261008000001CoreSchema";

  override up(): void {
    // ---------------------------------------------------------------- types
    this.addSql(
      `CREATE TYPE wager_transaction_kind AS ENUM ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')`,
    );
    this.addSql(
      `CREATE TYPE wager_transaction_status AS ENUM ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')`,
    );
    this.addSql(`CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'CREDIT')`);

    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid           PRIMARY KEY,
        player_id       uuid           NOT NULL,
        currency        char(3)        NOT NULL,
        balance_amount  numeric(20, 2) NOT NULL,
        version         integer        NOT NULL,
        created_at      timestamptz    NOT NULL,
        updated_at      timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uk UNIQUE (player_id, currency),
        CONSTRAINT wallets_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_ck CHECK (version >= 1),
        CONSTRAINT wallets_timestamps_ck CHECK (updated_at >= created_at)
      )`);

    // ---------------------------------------------------------------- wager transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid                     PRIMARY KEY,
        provider_id                       text                     NOT NULL,
        external_transaction_id           text                     NOT NULL,
        idempotency_key                   text                     NOT NULL,
        payload_hash                      text                     NOT NULL,
        wallet_id                         uuid                     NOT NULL REFERENCES wallets (id),
        player_id                         uuid                     NOT NULL,
        round_id                          text                     NOT NULL,
        game_id                           text                     NOT NULL,
        kind                              wager_transaction_kind   NOT NULL,
        amount                            numeric(20, 2)           NOT NULL,
        currency                          char(3)                  NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid,
        status                            wager_transaction_status NOT NULL,
        failure_code                      text,
        result_balance_amount             numeric(20, 2),
        reference_attempts                integer                  NOT NULL DEFAULT 0,
        next_reference_retry_at           timestamptz,
        created_at                        timestamptz              NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_tx_idempotency_key_uk UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uk UNIQUE (provider_id, external_transaction_id),
        -- target of the composite FK below: a reference must live in the same wallet
        CONSTRAINT wager_tx_id_wallet_uk UNIQUE (id, wallet_id),
        CONSTRAINT wager_tx_reference_same_wallet_fk FOREIGN KEY (reference_transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT wager_tx_provider_len_ck CHECK (length(provider_id) BETWEEN 1 AND 64),
        CONSTRAINT wager_tx_external_len_ck CHECK (length(external_transaction_id) BETWEEN 1 AND 128),
        CONSTRAINT wager_tx_idem_len_ck CHECK (length(idempotency_key) BETWEEN 1 AND 255),
        CONSTRAINT wager_tx_payload_hash_ck CHECK (payload_hash ~ '^v[0-9]+:[0-9a-f]{64}$'),
        CONSTRAINT wager_tx_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_amount_ck CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_tx_result_balance_ck CHECK (result_balance_amount IS NULL OR result_balance_amount >= 0),
        CONSTRAINT wager_tx_attempts_ck CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_reversal_requires_ref_ck
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_no_ref_for_bet_ck
          CHECK (kind NOT IN ('BET', 'OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_ref_resolution_ck
          CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_ck
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_terminal_timestamp_ck
          CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_processed_balance_ck CHECK (status <> 'PROCESSED' OR result_balance_amount IS NOT NULL),
        CONSTRAINT wager_tx_pending_ref_retry_ck
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_retry_at IS NOT NULL)),
        CONSTRAINT wager_tx_processed_ref_ck
          CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL)
      )`);
    // A referenced transaction can be reversed at most once (REFUND or ROLLBACK, whichever is PROCESSED first).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uk ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_ref_due_idx ON wager_transactions (next_reference_retry_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_ref_lookup_idx ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_wallet_created_idx ON wager_transactions (wallet_id, created_at)`);

    // ---------------------------------------------------------------- ledger
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid             PRIMARY KEY,
        wallet_id       uuid             NOT NULL REFERENCES wallets (id),
        transaction_id  uuid             NOT NULL,
        direction       ledger_direction NOT NULL,
        amount          numeric(20, 2)   NOT NULL,
        currency        char(3)          NOT NULL,
        balance_before  numeric(20, 2)   NOT NULL,
        balance_after   numeric(20, 2)   NOT NULL,
        wallet_version  integer          NOT NULL,
        created_at      timestamptz      NOT NULL,
        CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ledger_one_entry_per_tx_wallet_uk UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_one_entry_per_version_uk UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_version_ck CHECK (wallet_version >= 1),
        CONSTRAINT ledger_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ledger_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      )`);

    // ---------------------------------------------------------------- inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  text        NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      )`);
    this.addSql(`CREATE INDEX inbox_messages_received_idx ON inbox_messages (received_at)`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        seq             bigint      GENERATED ALWAYS AS IDENTITY,
        aggregate_id    uuid        NOT NULL,
        event_type      text        NOT NULL,
        event_version   integer     NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL,
        locked_until    timestamptz,
        locked_by       text,
        published_at    timestamptz,
        last_error      text,
        CONSTRAINT outbox_seq_uk UNIQUE (seq),
        CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
        CONSTRAINT outbox_event_version_ck CHECK (event_version >= 1)
      )`);
    this.addSql(`
      CREATE INDEX outbox_unpublished_due_idx ON outbox_messages (next_attempt_at, seq)
        WHERE published_at IS NULL`);

    // ---------------------------------------------------------------- guard triggers
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is forbidden: table is append-only', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);

    // Ledger chain: each entry continues the previous one of the same wallet.
    this.addSql(`
      CREATE FUNCTION ledger_entry_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        prev_after numeric(20, 2);
        wallet_currency char(3);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'ledger entry currency % differs from wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT balance_after INTO prev_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;

        IF FOUND THEN
          IF prev_after <> NEW.balance_before THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: version % starts at % but previous ended at %',
              NEW.wallet_id, NEW.wallet_version, NEW.balance_before, prev_after
              USING ERRCODE = 'check_violation';
          END IF;
        ELSE
          -- First entry of the wallet: either the OPENING credit (v1) or the first movement of a zero-opened wallet (v2).
          IF NEW.wallet_version NOT IN (1, 2) OR NEW.balance_before <> 0
             OR EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id) THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: no entry for version %', NEW.wallet_id, NEW.wallet_version - 1
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_chain_guard()`);

    // Only PROCESSED, balance-moving transactions may have a ledger line, with the same amount and currency.
    // Deferred so statement order inside the transaction does not matter.
    this.addSql(`
      CREATE FUNCTION ledger_entry_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE tx record;
      BEGIN
        SELECT status, kind, amount, currency INTO tx FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' OR tx.amount <> NEW.amount OR tx.currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger entry % does not match a PROCESSED balance-moving transaction', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_transaction_match
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_transaction_guard()`);

    // Wallet guard: identity columns are immutable; version moves by exactly +1 iff the balance moves.
    this.addSql(`
      CREATE FUNCTION wallets_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM
           (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.balance_amount <> OLD.balance_amount AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'balance change must bump version by exactly 1' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance_amount = OLD.balance_amount AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'version may only change with the balance' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard
        BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_update_guard()`);

    // Wallet <-> ledger consistency, checked at COMMIT: the wallet's current (version, balance) must be the
    // last link of its ledger chain. Together with UNIQUE(wallet_id, wallet_version) and the chain trigger,
    // this makes "every balance change has exactly one ledger line (and vice versa)" a schema guarantee.
    this.addSql(`
      CREATE FUNCTION assert_wallet_ledger_consistent(p_wallet_id uuid) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE w record;
      BEGIN
        SELECT id, version, balance_amount INTO w FROM wallets WHERE id = p_wallet_id;
        IF EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = w.id AND wallet_version > w.version) THEN
          RAISE EXCEPTION 'wallet % has ledger entries beyond version %', w.id, w.version
            USING ERRCODE = 'check_violation';
        END IF;
        IF w.version = 1 AND w.balance_amount = 0
           AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = w.id) THEN
          RETURN; -- opened with zero balance, untouched
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries
           WHERE wallet_id = w.id AND wallet_version = w.version AND balance_after = w.balance_amount
        ) THEN
          RAISE EXCEPTION 'wallet % (version %, balance %) has no matching ledger entry', w.id, w.version, w.balance_amount
            USING ERRCODE = 'check_violation';
        END IF;
      END $$`);
    this.addSql(`
      CREATE FUNCTION wallets_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_wallet_ledger_consistent(NEW.id);
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE FUNCTION ledger_entry_wallet_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_wallet_ledger_consistent(NEW.wallet_id);
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_ledger_consistency()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_wallet_consistency
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_wallet_consistency()`);

    // Terminal transactions are frozen; business columns are always immutable; nothing is ever deleted.
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transactions cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager transaction business columns are immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);

    // ---------------------------------------------------------------- privileges (least privilege runtime role)
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
          GRANT SELECT, INSERT, UPDATE ON wallets TO wagering_app;
          GRANT SELECT, INSERT, UPDATE ON wager_transactions TO wagering_app;
          GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app;
          GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_messages TO wagering_app;
          GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_messages TO wagering_app;
        END IF;
      END $$`);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_ledger_consistency()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entry_wallet_consistency()`);
    this.addSql(`DROP FUNCTION IF EXISTS assert_wallet_ledger_consistent(uuid)`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_update_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transactions_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entry_transaction_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entry_chain_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_mutation()`);
    this.addSql(`DROP TYPE IF EXISTS ledger_direction`);
    this.addSql(`DROP TYPE IF EXISTS wager_transaction_status`);
    this.addSql(`DROP TYPE IF EXISTS wager_transaction_kind`);
  }
}
