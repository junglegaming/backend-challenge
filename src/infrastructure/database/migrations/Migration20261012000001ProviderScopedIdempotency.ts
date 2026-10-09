import { Migration } from "@mikro-orm/migrations";

/**
 * Idempotency keys become unique per provider: UNIQUE (provider_id, idempotency_key) instead of a global
 * UNIQUE (idempotency_key).
 *
 * With a global key, provider B reusing a key already taken by provider A got a 409 that carried A's transactionId
 * (cross-tenant leak), and any provider could "squat" keys another one would later use. Each provider owns its key
 * space — the same way (provider_id, external_transaction_id) already worked.
 *
 * down() restores the global constraint and therefore fails if two providers already share a key: that is
 * deliberate, a rollback must never silently merge two providers' submissions.
 */
export class Migration20261012000001ProviderScopedIdempotency extends Migration {
  override name = "Migration20261012000001ProviderScopedIdempotency";

  override up(): void {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_tx_idempotency_key_uk;
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_tx_provider_idempotency_uk UNIQUE (provider_id, idempotency_key);`);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_tx_provider_idempotency_uk;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_tx_idempotency_key_uk UNIQUE (idempotency_key);`);
  }
}
