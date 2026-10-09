import { Migration } from "@mikro-orm/migrations";

/**
 * Audit trail of submissions that did not become a business outcome (validation errors, idempotency conflicts,
 * unknown wallets, poison messages, exhausted retries, unexpected errors).
 *
 * Kept OUTSIDE wager_transactions on purpose: these rows have no valid identity or would violate the constraints
 * that protect the ledger, and they must never occupy an idempotency key (the provider may fix and resend).
 * Rows are immutable (UPDATE forbidden); DELETE is allowed only for retention.
 */
export class Migration20261010000001SubmissionFailureAudit extends Migration {
  override name = "Migration20261010000001SubmissionFailureAudit";

  override up(): void {
    this.addSql(`
      CREATE TABLE wager_submission_failures (
        id                      uuid        PRIMARY KEY,
        channel                 text        NOT NULL,
        reason_code             text        NOT NULL,
        category                text        NOT NULL,
        retryable               boolean     NOT NULL,
        provider_id             text,
        external_transaction_id text,
        idempotency_key         text,
        wallet_id               uuid,
        message_id              text,
        transaction_id          uuid REFERENCES wager_transactions (id),
        payload_hash            text,
        detail                  text,
        receive_count           integer,
        correlation_id          text,
        occurred_at             timestamptz NOT NULL,
        CONSTRAINT submission_failures_channel_ck CHECK (channel IN ('http', 'sqs')),
        CONSTRAINT submission_failures_reason_ck CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
        CONSTRAINT submission_failures_category_ck
          CHECK (category IN ('VALIDATION', 'CONFLICT', 'UNPROCESSABLE', 'INFRASTRUCTURE')),
        CONSTRAINT submission_failures_detail_len_ck CHECK (detail IS NULL OR length(detail) <= 500),
        CONSTRAINT submission_failures_receive_count_ck CHECK (receive_count IS NULL OR receive_count >= 1)
      )`);
    this.addSql(`
      CREATE INDEX submission_failures_external_idx
        ON wager_submission_failures (provider_id, external_transaction_id, occurred_at DESC)`);
    this.addSql(`CREATE INDEX submission_failures_occurred_idx ON wager_submission_failures (occurred_at)`);
    this.addSql(`
      CREATE TRIGGER wager_submission_failures_immutable
        BEFORE UPDATE ON wager_submission_failures
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
          GRANT SELECT, INSERT, DELETE ON wager_submission_failures TO wagering_app;
        END IF;
      END $$`);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS wager_submission_failures`);
  }
}
