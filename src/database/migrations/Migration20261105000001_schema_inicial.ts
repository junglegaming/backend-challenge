import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade e não-negatividade ficam no banco
 * (CHECK / UNIQUE), não só no código.
 */
export class Migration20261105000001_schema_inicial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id         uuid           PRIMARY KEY,
        player_id  uuid           NOT NULL,
        currency   char(3)        NOT NULL,
        balance    numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version    integer        NOT NULL CHECK (version >= 1),
        created_at timestamptz    NOT NULL,
        updated_at timestamptz    NOT NULL,
        CONSTRAINT wallets_player_id_currency_key UNIQUE (player_id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid           PRIMARY KEY,
        provider_id                       varchar(64)    NOT NULL,
        external_transaction_id           varchar(128)   NOT NULL,
        idempotency_key                   varchar(256)   NOT NULL,
        payload_hash                      varchar(64)    NOT NULL,
        wallet_id                         uuid           NOT NULL REFERENCES wallets (id),
        player_id                         uuid           NOT NULL,
        round_id                          varchar(128)   NOT NULL,
        game_id                           varchar(128)   NOT NULL,
        kind                              varchar(16)    NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            numeric(20, 2) NOT NULL CHECK (amount >= 0),
        currency                          char(3)        NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid REFERENCES wager_transactions (id),
        status                            varchar(24)    NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      varchar(64),
        balance_after                     numeric(20, 2),
        reference_attempts                integer        NOT NULL DEFAULT 0,
        next_reference_check_at           timestamptz,
        correlation_id                    varchar(128)   NOT NULL,
        created_at                        timestamptz    NOT NULL,
        updated_at                        timestamptz    NOT NULL,
        processed_at                      timestamptz,

        -- idempotência persistente
        CONSTRAINT wager_transactions_idempotency_key_key UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_key UNIQUE (provider_id, external_transaction_id),
        -- REFUND / ROLLBACK sempre trazem a referência
        CONSTRAINT wager_transactions_reference_required CHECK
          (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        -- rejeição/falha sempre tem failure_code
        CONSTRAINT wager_transactions_failure_code CHECK
          ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL))
      )`);

    // Uma transação só pode ser revertida (REFUND ou ROLLBACK) uma única vez.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal_key
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`);
    // Varredura do worker de PENDING_REFERENCE.
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE'`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid           PRIMARY KEY,
        wallet_id      uuid           NOT NULL REFERENCES wallets (id),
        transaction_id uuid           NOT NULL REFERENCES wager_transactions (id),
        direction      varchar(6)     NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount         numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency       char(3)        NOT NULL,
        balance_before numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after  numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        wallet_version integer        NOT NULL,
        created_at     timestamptz    NOT NULL,
        CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        ),
        -- no máximo um lançamento por transação por wallet
        CONSTRAINT wallet_ledger_entries_wallet_transaction_key UNIQUE (wallet_id, transaction_id),
        -- dois escritores concorrentes não conseguem gravar a mesma versão da wallet
        CONSTRAINT wallet_ledger_entries_wallet_version_key UNIQUE (wallet_id, wallet_version)
      )`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(128) NOT NULL,
        message_id    varchar(256) NOT NULL,
        payload_hash  varchar(64)  NOT NULL,
        received_at   timestamptz  NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid         PRIMARY KEY,
        aggregate_id    varchar(128) NOT NULL,
        event_type      varchar(128) NOT NULL,
        payload         jsonb        NOT NULL,
        occurred_at     timestamptz  NOT NULL,
        attempts        integer      NOT NULL DEFAULT 0,
        next_attempt_at timestamptz  NOT NULL,
        published_at    timestamptz
      )`);
    this.addSql(`
      CREATE INDEX outbox_messages_pending_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
  }
}
