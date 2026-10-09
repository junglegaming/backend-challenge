import { Migration } from "@mikro-orm/migrations";

/**
 * Double-entry journal (optional differential). Every wallet ledger line gets two postings — the wallet leg and
 * the counterparty leg (provider clearing account, or system funding for OPENING) — and the journal must balance
 * per transaction at COMMIT. Existing ledger lines are back-filled so the invariant holds from the first row.
 */
export class Migration20261009000001DoubleEntryJournal extends Migration {
  override name = "Migration20261009000001DoubleEntryJournal";

  override up(): void {
    this.addSql(`
      CREATE TABLE ledger_postings (
        id             uuid             PRIMARY KEY,
        transaction_id uuid             NOT NULL REFERENCES wager_transactions (id),
        account        text             NOT NULL,
        direction      ledger_direction NOT NULL,
        amount         numeric(20, 2)   NOT NULL,
        currency       char(3)          NOT NULL,
        created_at     timestamptz      NOT NULL,
        CONSTRAINT ledger_postings_one_leg_per_account_uk UNIQUE (transaction_id, account),
        CONSTRAINT ledger_postings_amount_ck CHECK (amount > 0),
        CONSTRAINT ledger_postings_account_ck CHECK (account ~ '^(wallet|provider|system):.+'),
        CONSTRAINT ledger_postings_currency_ck CHECK (currency ~ '^[A-Z]{3}$')
      )`);
    this.addSql(`CREATE INDEX ledger_postings_account_idx ON ledger_postings (account, created_at)`);
    this.addSql(`
      CREATE TRIGGER ledger_postings_append_only
        BEFORE UPDATE OR DELETE ON ledger_postings
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER ledger_postings_no_truncate
        BEFORE TRUNCATE ON ledger_postings
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);

    // Σ debits = Σ credits, single currency, per transaction — checked at COMMIT.
    this.addSql(`
      CREATE FUNCTION ledger_postings_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)  AS debits,
               COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0) AS credits,
               COUNT(DISTINCT currency)                                      AS currencies
          INTO r
          FROM ledger_postings WHERE transaction_id = NEW.transaction_id;
        IF r.debits <> r.credits OR r.currencies <> 1 THEN
          RAISE EXCEPTION 'journal for transaction % does not balance (debits %, credits %)',
            NEW.transaction_id, r.debits, r.credits USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_postings_balanced
        AFTER INSERT ON ledger_postings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_postings_balanced()`);

    // Each wallet ledger line must have its wallet leg in the journal (same direction and amount).
    this.addSql(`
      CREATE FUNCTION ledger_entry_has_posting() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM ledger_postings
           WHERE transaction_id = NEW.transaction_id
             AND account = 'wallet:' || NEW.wallet_id
             AND direction = NEW.direction
             AND amount = NEW.amount
        ) THEN
          RAISE EXCEPTION 'ledger entry % has no matching journal posting', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);

    // Back-fill before enabling the cross-check, inside the same migration transaction.
    this.addSql(`
      INSERT INTO ledger_postings (id, transaction_id, account, direction, amount, currency, created_at)
      SELECT gen_random_uuid(), e.transaction_id, 'wallet:' || e.wallet_id, e.direction, e.amount, e.currency, e.created_at
        FROM wallet_ledger_entries e`);
    this.addSql(`
      INSERT INTO ledger_postings (id, transaction_id, account, direction, amount, currency, created_at)
      SELECT gen_random_uuid(), e.transaction_id,
             CASE WHEN t.kind = 'OPENING' THEN 'system:funding:' || e.currency
                  ELSE 'provider:' || t.provider_id || ':' || e.currency END,
             CASE e.direction WHEN 'DEBIT' THEN 'CREDIT'::ledger_direction ELSE 'DEBIT'::ledger_direction END,
             e.amount, e.currency, e.created_at
        FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id`);

    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_has_posting
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_has_posting()`);

    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
          GRANT SELECT, INSERT ON ledger_postings TO wagering_app;
        END IF;
      END $$`);
  }

  override down(): void {
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_has_posting ON wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entry_has_posting()`);
    this.addSql(`DROP TABLE IF EXISTS ledger_postings`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_postings_balanced()`);
  }
}
