import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000002_wallets extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20,2) not null,
        version integer not null default 1,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_balance_non_negative_ck check (balance >= 0),
        constraint wallets_version_positive_ck check (version >= 1),
        constraint wallets_currency_format_ck check (currency ~ '^[A-Z]{3}$')
      );
    `);
    // version moves by exactly +1 when (and only when) the balance changes; identity never changes.
    this.addSql(`
      create function wallets_guard_update() returns trigger language plpgsql as $$
      begin
        if new.id is distinct from old.id
           or new.player_id is distinct from old.player_id
           or new.currency is distinct from old.currency
           or new.created_at is distinct from old.created_at then
          raise exception 'wallet identity is immutable' using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance is distinct from old.balance then
          if new.version <> old.version + 1 then
            raise exception 'wallet version must increase by exactly 1 when the balance changes'
              using errcode = 'integrity_constraint_violation';
          end if;
        elsif new.version is distinct from old.version then
          raise exception 'wallet version can only change together with the balance'
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(
      'create trigger wallets_guard_update before update on wallets for each row execute function wallets_guard_update();',
    );
    this.addSql(
      'create trigger wallets_no_delete before delete on wallets for each row execute function forbid_mutation();',
    );
  }

  override down(): void {
    this.addSql('drop table if exists wallets;');
    this.addSql('drop function if exists wallets_guard_update();');
  }
}
