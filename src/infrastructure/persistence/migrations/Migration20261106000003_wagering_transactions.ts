import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000003_wagering_transactions extends Migration {
  override up(): void {
    this.addSql(`
      create table wagering_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        balance_snapshot numeric(20,2),
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wagering_transactions_reference_fk
          foreign key (reference_transaction_id) references wagering_transactions (id),
        constraint wagering_transactions_idempotency_key_uq unique (idempotency_key),
        constraint wagering_transactions_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wagering_transactions_kind_ck
          check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wagering_transactions_status_ck
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wagering_transactions_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wagering_transactions_amount_ck check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wagering_transactions_reversal_reference_ck
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wagering_transactions_failure_code_ck
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wagering_transactions_processed_at_ck
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wagering_transactions_balance_snapshot_ck
          check ((status = 'PROCESSED') = (balance_snapshot is not null) and coalesce(balance_snapshot, 0) >= 0),
        constraint wagering_transactions_reference_processed_ck
          check (reference_transaction_id is null or (status = 'PROCESSED' and reference_transaction_id <> id))
      );
    `);

    // A reference can be reversed once per kind (README rule 4)...
    this.addSql(`
      create unique index wagering_transactions_reversal_per_kind_uq
        on wagering_transactions (reference_transaction_id, kind) where status = 'PROCESSED';
    `);
    // ...and, stricter, once by ANY reversal: REFUND + ROLLBACK of the same BET would credit twice (ADR-004).
    this.addSql(`
      create unique index wagering_transactions_single_reversal_uq
        on wagering_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
    // Wallet history, newest-first/paged without a sort.
    this.addSql('create index wagering_transactions_wallet_idx on wagering_transactions (wallet_id, created_at);');
    // "Who is waiting for this reference?" — run when a BET/WIN/REFUND is processed. Tiny: only waiting rows.
    this.addSql(`
      create index wagering_transactions_waiting_reference_idx
        on wagering_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    // Scheduled worker scan over waiting rows, oldest first.
    this.addSql(`
      create index wagering_transactions_pending_reference_scan_idx
        on wagering_transactions (created_at) where status = 'PENDING_REFERENCE';
    `);

    // Terminal rows never change again; business identity is immutable; nothing is ever deleted.
    this.addSql(`
      create function wagering_transactions_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'transaction % is terminal (%) and cannot change', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
          raise exception 'transaction % cannot go back from PENDING_REFERENCE to PENDING', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.id is distinct from old.id
           or new.provider_id is distinct from old.provider_id
           or new.external_transaction_id is distinct from old.external_transaction_id
           or new.idempotency_key is distinct from old.idempotency_key
           or new.payload_hash is distinct from old.payload_hash
           or new.wallet_id is distinct from old.wallet_id
           or new.player_id is distinct from old.player_id
           or new.round_id is distinct from old.round_id
           or new.game_id is distinct from old.game_id
           or new.kind is distinct from old.kind
           or new.amount is distinct from old.amount
           or new.currency is distinct from old.currency
           or new.reference_external_transaction_id is distinct from old.reference_external_transaction_id
           or new.created_at is distinct from old.created_at then
          raise exception 'transaction % business fields are immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(
      'create trigger wagering_transactions_guard_update before update on wagering_transactions for each row execute function wagering_transactions_guard_update();',
    );
    this.addSql(
      'create trigger wagering_transactions_no_delete before delete on wagering_transactions for each row execute function forbid_mutation();',
    );
  }

  override down(): void {
    this.addSql('drop table if exists wagering_transactions;');
    this.addSql('drop function if exists wagering_transactions_guard_update();');
  }
}
