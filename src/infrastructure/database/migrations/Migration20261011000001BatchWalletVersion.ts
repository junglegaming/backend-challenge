import { Migration } from "@mikro-orm/migrations";

/**
 * Per-wallet batching writes the wallet row once per batch, so its version may advance by N (one per ledger line)
 * and the balance may even end where it started (BET 10 + WIN 10 = +2 versions, same balance).
 *
 * The old rule ("version moves by exactly +1 iff the balance moves") is replaced by a weaker row-level rule, while
 * the *real* guarantee stays in the schema and is unchanged:
 *   - UNIQUE (wallet_id, wallet_version) + chain trigger: versions are contiguous, each continues the previous one;
 *   - deferred wallets_ledger_consistency: at COMMIT, the wallet's (version, balance) is the last link of the chain.
 * Together they mean a version jump of N is accepted only if the N intermediate ledger lines exist — a jump that
 * skips any of them is still rejected (tested).
 */
export class Migration20261011000001BatchWalletVersion extends Migration {
  override name = "Migration20261011000001BatchWalletVersion";

  override up(): void {
    this.addSql(`
      CREATE OR REPLACE FUNCTION wallets_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM
           (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.version < OLD.version THEN
          RAISE EXCEPTION 'wallet version cannot decrease' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance_amount <> OLD.balance_amount AND NEW.version = OLD.version THEN
          RAISE EXCEPTION 'balance change must increase the version' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
  }

  override down(): void {
    this.addSql(`
      CREATE OR REPLACE FUNCTION wallets_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  }
}
