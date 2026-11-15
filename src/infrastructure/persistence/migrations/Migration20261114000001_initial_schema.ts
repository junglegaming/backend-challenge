import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every guarantee listed in section 6 of the challenge is
 * enforced by PostgreSQL itself, so a buggy code path (or a manual UPDATE)
 * cannot break it:
 *
 *  - uniqueness: one wallet per (player, currency); one transaction per
 *    idempotency key and per (provider, external id); one ledger entry per
 *    (transaction, wallet) and per (wallet, wallet_version); one successful
 *    reversal per referenced transaction; one inbox row per (consumer, message).
 *  - non-negativity: CHECK (balance >= 0) on wallets and ledger balances.
 *  - immutability: ledger rows can never be updated/deleted; terminal
 *    transactions can never change; business columns of a transaction and of
 *    an outbox payload are write-once.
 *  - balance <-> ledger consistency: each ledger row must chain onto the
 *    previous one (balance_before = previous balance_after, version + 1) and a
 *    DEFERRED constraint trigger checks, at COMMIT, that the wallet balance
 *    and version equal the head of its ledger chain.
 */
export class Migration20261114000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_id_currency_key UNIQUE (player_id, currency)
      );
    `);

    // ------------------------------------------------------- wager transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(128)   NOT NULL,
        external_transaction_id            varchar(255)   NOT NULL,
        idempotency_key                    varchar(512)   NOT NULL,
        payload_hash                       char(64)       NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id),
        player_id                          uuid           NOT NULL,
        round_id                           varchar(255)   NOT NULL,
        game_id                            varchar(255)   NOT NULL,
        kind                               varchar(16)    NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency                           char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  varchar(255),
        reference_transaction_id           uuid           REFERENCES wager_transactions (id),
        status                             varchar(24)    NOT NULL
          CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       varchar(64),
        result_balance                     numeric(20, 2) CHECK (result_balance >= 0),
        reference_attempts                 integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_check_at            timestamptz,
        created_at                         timestamptz    NOT NULL,
        updated_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,

        CONSTRAINT wager_transactions_idempotency_key_key UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_key UNIQUE (provider_id, external_transaction_id),
        -- REFUND / ROLLBACK must carry a reference
        CONSTRAINT wager_transactions_reference_required
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        -- OPENING is internal only
        CONSTRAINT wager_transactions_opening_internal
          CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        -- failure code exactly on REJECTED / FAILED
        CONSTRAINT wager_transactions_failure_code
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_at
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_pending_schedule
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_check_at IS NOT NULL)),
        CONSTRAINT wager_transactions_resolved_reference
          CHECK (reference_transaction_id IS NULL OR status = 'PROCESSED')
      );
    `);
    // A referenced transaction can be reversed (REFUND or ROLLBACK) only once.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_due
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_by_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_transactions_wallet ON wager_transactions (wallet_id, created_at);`);

    // ---------------------------------------------------------- ledger entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        sequence        bigint         GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id       uuid           NOT NULL REFERENCES wallets (id),
        transaction_id  uuid           NOT NULL
          REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        direction       varchar(6)     NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency        char(3)        NOT NULL,
        balance_before  numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        wallet_version  integer        NOT NULL CHECK (wallet_version >= 1),
        created_at      timestamptz    NOT NULL,

        CONSTRAINT wallet_ledger_entries_transaction_wallet_key UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wallet_ledger_entries_wallet_version_key UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    // ------------------------------------------------------------------ inbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(128) NOT NULL,
        message_id     varchar(255) NOT NULL,
        payload_hash   char(64)     NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ----------------------------------------------------------------- outbox
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid         PRIMARY KEY,
        sequence         bigint       GENERATED ALWAYS AS IDENTITY UNIQUE,
        aggregate_id     uuid         NOT NULL,
        event_type       varchar(128) NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz  NOT NULL,
        published_at     timestamptz,
        locked_by        varchar(128),
        locked_until     timestamptz,
        last_error       text
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_due
        ON outbox_messages (next_attempt_at, sequence)
        WHERE published_at IS NULL;
    `);

    // ================================================================ triggers
    this.addSql(`
      CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is forbidden (append-only)', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_change();
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
    `);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete
        BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION forbid_change();
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_change();
    `);

    // Ledger chain: every entry continues the previous one of the same wallet.
    this.addSql(`
      CREATE FUNCTION ledger_entry_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous wallet_ledger_entries%ROWTYPE;
        wallet_currency char(3);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'ledger currency % differs from wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT * INTO previous FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
        IF FOUND THEN
          IF previous.balance_after <> NEW.balance_before THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: % <> %', NEW.wallet_id, previous.balance_after, NEW.balance_before
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NOT (NEW.balance_before = 0 AND NEW.wallet_version <= 2
                   AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id)) THEN
          -- only the very first entry of a wallet may start the chain (version 1 when
          -- opened with funds, version 2 when opened empty), and it must start at zero
          RAISE EXCEPTION 'ledger entry for wallet % does not continue the chain (version %)', NEW.wallet_id, NEW.wallet_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_chain();
    `);

    // Wallet updates: identity is immutable, version moves with (and only with) the balance.
    this.addSql(`
      CREATE FUNCTION wallet_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'balance change must increment version by exactly 1' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'version may only change together with the balance' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallets_guard_update
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallet_guard_update();
    `);

    // At COMMIT: wallet state == head of its ledger chain.
    this.addSql(`
      CREATE FUNCTION wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        w wallets%ROWTYPE;
        head wallet_ledger_entries%ROWTYPE;
      BEGIN
        SELECT * INTO w FROM wallets WHERE id = NEW.id;
        SELECT * INTO head FROM wallet_ledger_entries
         WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF w.balance <> 0 OR w.version <> 1 THEN
            RAISE EXCEPTION 'wallet % has balance % without ledger entries', w.id, w.balance
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF head.balance_after <> w.balance OR head.wallet_version <> w.version THEN
          RAISE EXCEPTION 'wallet % (balance %, version %) diverges from ledger head (balance %, version %)',
            w.id, w.balance, w.version, head.balance_after, head.wallet_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_match_ledger
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger();
    `);

    // Transactions: business columns are write-once; terminal states are final.
    this.addSql(`
      CREATE FUNCTION wager_transaction_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'business columns of transaction % are immutable', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_update
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transaction_guard_update();
    `);

    // Outbox: the event itself is write-once (only delivery bookkeeping may change).
    this.addSql(`
      CREATE FUNCTION outbox_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox event % is immutable', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox event % already published', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER outbox_messages_guard_update
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard_update();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS outbox_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS wager_transaction_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_matches_ledger();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS ledger_entry_chain();');
    this.addSql('DROP FUNCTION IF EXISTS forbid_change();');
  }
}
