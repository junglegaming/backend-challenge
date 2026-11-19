import { Migration } from '@mikro-orm/migrations';

/**
 * As invariantes financeiras moram aqui, não só na aplicação: mesmo com bug no código (ou escrita
 * manual via psql), o Postgres recusa saldo negativo, lançamento alterado, dupla reversão,
 * transação terminal modificada e saldo divergente do ledger.
 */
export class Migration20261119000000_init extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20,2) not null check (amount >= 0),
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        resulting_balance numeric(20,2),
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_transactions_amount_positive_ck check (kind = 'LOSS' or amount > 0),
        constraint wager_transactions_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_ck
          check (status not in ('PROCESSED', 'REJECTED', 'FAILED') or processed_at is not null)
      );
    `);
    // Uma transação só pode ser revertida uma vez (REFUND ou ROLLBACK). Garantido pelo banco.
    this.addSql(`
      create unique index wager_transactions_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted' using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transaction % is terminal (%) and cannot change', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        sequence bigint generated always as identity,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20,2) not null check (amount > 0),
        currency char(3) not null,
        balance_before numeric(20,2) not null check (balance_before >= 0),
        balance_after numeric(20,2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint wallet_ledger_entries_transaction_uq unique (transaction_id),
        constraint wallet_ledger_entries_wallet_sequence_uq unique (wallet_id, sequence),
        constraint wallet_ledger_entries_balanced_ck
          check (balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end)
      );
    `);
    this.addSql(`
      create function wallet_ledger_entries_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% not allowed)', tg_op
          using errcode = 'restrict_violation';
      end $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_immutable();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_immutable();
    `);
    // Cadeia: o balance_before de um lançamento é o balance_after do anterior da mesma wallet.
    this.addSql(`
      create function wallet_ledger_entries_chain() returns trigger language plpgsql as $$
      declare previous numeric(20,2);
      begin
        select balance_after into previous from wallet_ledger_entries
          where wallet_id = new.wallet_id order by sequence desc limit 1;
        if new.balance_before <> coalesce(previous, 0) then
          raise exception 'ledger chain broken for wallet %: balance_before % but previous balance_after %',
            new.wallet_id, new.balance_before, coalesce(previous, 0) using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_chain before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_chain();
    `);
    // Saldo materializado == ledger. Deferred: verificado no COMMIT, quando wallet e ledger já foram escritos.
    this.addSql(`
      create function wallet_balance_matches_ledger() returns trigger language plpgsql as $$
      declare
        target uuid := case tg_table_name when 'wallets' then new.id else new.wallet_id end;
        stored numeric(20,2);
        ledger numeric(20,2);
      begin
        select balance into stored from wallets where id = target;
        select balance_after into ledger from wallet_ledger_entries
          where wallet_id = target order by sequence desc limit 1;
        if stored <> coalesce(ledger, 0) then
          raise exception 'wallet % balance % diverges from ledger %', target, stored, coalesce(ledger, 0)
            using errcode = 'check_violation';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`
      create constraint trigger wallets_balance_matches_ledger after insert or update of balance on wallets
        deferrable initially deferred for each row execute function wallet_balance_matches_ledger();
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_balance_matches_wallet after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function wallet_balance_matches_ledger();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        sequence bigint generated always as identity,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz
      );
    `);
    this.addSql(`create index outbox_messages_pending_idx on outbox_messages (sequence) where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table outbox_messages;`);
    this.addSql(`drop table inbox_messages;`);
    this.addSql(`drop table wallet_ledger_entries;`);
    this.addSql(`drop table wager_transactions;`);
    this.addSql(`drop table wallets;`);
    this.addSql(`drop function wallet_balance_matches_ledger();`);
    this.addSql(`drop function wallet_ledger_entries_chain();`);
    this.addSql(`drop function wallet_ledger_entries_immutable();`);
    this.addSql(`drop function wager_transactions_guard();`);
  }
}
