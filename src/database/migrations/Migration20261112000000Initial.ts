import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema.
 *
 * The database is the last line of defense: every uniqueness, immutability and
 * non-negativity guarantee of the domain is also enforced here, so even a bug
 * in application code (or a manual SQL session) cannot break the invariants.
 */
export class Migration20261112000000Initial extends Migration {
  override async up(): Promise<void> {
    // ---- wallets ------------------------------------------------------------
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL CONSTRAINT wallets_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2)  NOT NULL CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        version     integer        NOT NULL CONSTRAINT wallets_version_ck CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        -- At most one wallet per player and currency.
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency)
      )`);

    // ---- wager transactions ---------------------------------------------------
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          PRIMARY KEY,
        provider_id                        varchar(64)   NOT NULL,
        external_transaction_id            varchar(128)  NOT NULL,
        idempotency_key                    varchar(255)  NOT NULL,
        payload_hash                       char(64)      NOT NULL,
        wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
        player_id                          uuid          NOT NULL,
        round_id                           varchar(128)  NOT NULL,
        game_id                            varchar(128)  NOT NULL,
        kind                               varchar(16)   NOT NULL CONSTRAINT wager_tx_kind_ck
                                             CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(20,2) NOT NULL CONSTRAINT wager_tx_amount_non_negative_ck CHECK (amount >= 0),
        currency                           char(3)       NOT NULL,
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid          REFERENCES wager_transactions (id),
        status                             varchar(20)   NOT NULL CONSTRAINT wager_tx_status_ck
                                             CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       varchar(64),
        balance_after                      numeric(20,2) CONSTRAINT wager_tx_balance_after_ck CHECK (balance_after >= 0),
        reference_attempts                 integer       NOT NULL DEFAULT 0 CONSTRAINT wager_tx_attempts_ck CHECK (reference_attempts >= 0),
        next_reference_attempt_at          timestamptz,
        correlation_id                     varchar(128)  NOT NULL,
        created_at                         timestamptz   NOT NULL,
        processed_at                       timestamptz,
        updated_at                         timestamptz   NOT NULL,
        -- Persistent idempotency, scoped per provider.
        CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq    UNIQUE (provider_id, external_transaction_id),
        -- Only LOSS may carry a zero amount.
        CONSTRAINT wager_tx_positive_amount_ck CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT wager_tx_reference_required_ck
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_ck
          CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_processed_at_ck
          CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_pending_schedule_ck
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL)
      )`);

    // A transaction can be reversed (REFUND or ROLLBACK) only once.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);
    // Fast lookup of due out-of-order transactions by the scheduled worker.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id)`);

    // Terminal transactions are frozen and business fields never change; rows are never deleted.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.kind, NEW.amount, NEW.currency)
           IS DISTINCT FROM
           (OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.kind, OLD.amount, OLD.currency) THEN
          RAISE EXCEPTION 'business fields of transaction % are immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_trg
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()`);

    // ---- ledger -----------------------------------------------------------------
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        seq             bigint         GENERATED BY DEFAULT AS IDENTITY CONSTRAINT ledger_seq_uq UNIQUE,
        wallet_id       uuid           NOT NULL REFERENCES wallets (id),
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id),
        direction       varchar(6)     NOT NULL CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2)  NOT NULL CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        currency        char(3)        NOT NULL,
        balance_before  numeric(20,2)  NOT NULL CONSTRAINT ledger_balance_before_ck CHECK (balance_before >= 0),
        balance_after   numeric(20,2)  NOT NULL CONSTRAINT ledger_balance_after_ck CHECK (balance_after >= 0),
        wallet_version  integer        NOT NULL CONSTRAINT ledger_wallet_version_ck CHECK (wallet_version >= 1),
        created_at      timestamptz    NOT NULL,
        -- At most one entry per transaction per wallet.
        CONSTRAINT ledger_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        -- One entry per wallet version: two concurrent writers can never both "win".
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        -- balance_before ± amount = balance_after
        CONSTRAINT ledger_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      )`);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq)`);

    // Append-only: UPDATE, DELETE and TRUNCATE are rejected.
    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_append_only_row_trg
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only()`);
    this.addSql(`
      CREATE TRIGGER ledger_append_only_truncate_trg
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only()`);

    // Wallet <-> ledger consistency, checked at COMMIT (deferred) so a
    // transaction can update the wallet and insert the entry in any order:
    // the wallet (balance, version) must equal the latest ledger entry, or be
    // (0.00, 1) when the wallet has no entries yet.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target_wallet uuid;
        w RECORD;
        latest RECORD;
      BEGIN
        target_wallet := COALESCE((to_jsonb(NEW)->>'wallet_id')::uuid, NEW.id);
        SELECT balance, version INTO w FROM wallets WHERE id = target_wallet;
        SELECT balance_after, wallet_version INTO latest
          FROM wallet_ledger_entries WHERE wallet_id = target_wallet
          ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF w.balance <> 0 OR w.version <> 1 THEN
            RAISE EXCEPTION 'wallet % changed without a ledger entry', target_wallet USING ERRCODE = 'check_violation';
          END IF;
        ELSIF latest.wallet_version <> w.version OR latest.balance_after <> w.balance THEN
          RAISE EXCEPTION 'wallet % diverges from its ledger', target_wallet USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency_trg
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_consistency()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency_trg
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_consistency()`);

    // ---- inbox / outbox ---------------------------------------------------------
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(64)   NOT NULL,
        message_id     varchar(128)  NOT NULL,
        payload_hash   char(64)      NOT NULL,
        received_at    timestamptz   NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid          PRIMARY KEY,
        aggregate_id     uuid          NOT NULL,
        event_type       varchar(64)   NOT NULL,
        payload          jsonb         NOT NULL,
        occurred_at      timestamptz   NOT NULL,
        attempts         integer       NOT NULL DEFAULT 0 CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
        next_attempt_at  timestamptz   NOT NULL,
        published_at     timestamptz,
        locked_by        varchar(128),
        locked_until     timestamptz,
        last_error       varchar(500)
      )`);
    this.addSql(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_consistency()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_append_only()`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_guard()`);
  }
}

