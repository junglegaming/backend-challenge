import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000004_wallet_ledger_entries extends Migration {
  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        seq bigint generated always as identity,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wagering_transactions (id),
        direction text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_seq_uq unique (seq),
        constraint wallet_ledger_entries_wallet_transaction_uq unique (wallet_id, transaction_id),
        constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT','CREDIT')),
        constraint wallet_ledger_entries_amount_positive_ck check (amount > 0),
        constraint wallet_ledger_entries_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_balances_non_negative_ck check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_arithmetic_ck check (
          (direction = 'CREDIT' and balance_before + amount = balance_after)
          or (direction = 'DEBIT' and balance_before - amount = balance_after)
        )
      );
    `);
    // seq gives a stable, gap-tolerant per-wallet order for opaque cursors (keyset pagination, no OFFSET, no sort).
    // INCLUDE makes reconciliation (sum of signed amounts) an index-only scan.
    this.addSql(`
      create index wallet_ledger_entries_wallet_seq_idx
        on wallet_ledger_entries (wallet_id, seq) include (direction, amount);
    `);
    // Ledger entry of a transaction (the unique (wallet_id, transaction_id) cannot serve transaction_id alone).
    this.addSql('create index wallet_ledger_entries_transaction_idx on wallet_ledger_entries (transaction_id);');

    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_mutation();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_mutation();
    `);
  }

  override down(): void {
    this.addSql('drop table if exists wallet_ledger_entries;');
  }
}
