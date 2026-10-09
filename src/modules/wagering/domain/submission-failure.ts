/**
 * Audit record of a submission that did NOT become a business outcome (PROCESSED / REJECTED / PENDING_REFERENCE):
 * malformed payloads, idempotency conflicts, unknown wallets, poison messages, exhausted retries.
 *
 * Why a separate record instead of a wager_transactions row:
 *  - most of these submissions have no valid identity (no parsable wallet, provider or key) or would violate the
 *    very constraints that protect the ledger (an idempotency conflict cannot reuse the key; an unknown wallet
 *    cannot satisfy the FK);
 *  - a terminal row (FAILED) would make every future retry with the same key replay the failure forever, turning a
 *    recoverable infrastructure hiccup into a permanent business answer.
 * The audit trail is append-only, never occupies the idempotency key, and is queryable by the provider.
 */
export enum SubmissionFailureCategory {
  /** The payload or message is malformed: fix it, do not resend unchanged. */
  Validation = "VALIDATION",
  /** The key/messageId was already used with different content: do not resend. */
  Conflict = "CONFLICT",
  /** Well-formed but can never be applied as sent (e.g. unknown wallet). */
  Unprocessable = "UNPROCESSABLE",
  /** Infrastructure: transient failures that exhausted their retries, or unexpected errors. */
  Infrastructure = "INFRASTRUCTURE",
}

export type SubmissionChannel = "http" | "sqs";

export interface RecordSubmissionFailureProps {
  id: string;
  channel: SubmissionChannel;
  reasonCode: string;
  category: SubmissionFailureCategory;
  /** Can the provider resend the same request with the same key and expect it to work later? */
  retryable: boolean;
  providerId?: string | undefined;
  externalTransactionId?: string | undefined;
  idempotencyKey?: string | undefined;
  walletId?: string | undefined;
  messageId?: string | undefined;
  /** Set when the failure produced a FAILED wager transaction. */
  transactionId?: string | undefined;
  payloadHash?: string | undefined;
  detail?: string | undefined;
  receiveCount?: number | undefined;
  correlationId?: string | undefined;
  occurredAt: Date;
}

export type SubmissionFailureState = RecordSubmissionFailureProps;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Only well-formed identifiers survive: whatever an attacker or a broken client sends never reaches the audit as-is. */
const safeId = (v: unknown, max = 128): string | undefined =>
  typeof v === "string" && v.length <= max && SAFE_ID.test(v) ? v : undefined;

export class SubmissionFailure {
  private constructor(private readonly state: Readonly<SubmissionFailureState>) {
    Object.freeze(this);
  }

  /** Builds an audit record from untrusted input: identifiers are validated, the detail is truncated. */
  static record(props: RecordSubmissionFailureProps): SubmissionFailure {
    if (!REASON.test(props.reasonCode)) throw new Error(`invalid reason code ${props.reasonCode}`);
    return new SubmissionFailure({
      ...props,
      providerId: safeId(props.providerId, 64),
      externalTransactionId: safeId(props.externalTransactionId),
      idempotencyKey: safeId(props.idempotencyKey, 255),
      walletId: typeof props.walletId === "string" && UUID.test(props.walletId) ? props.walletId : undefined,
      messageId: safeId(props.messageId),
      correlationId: safeId(props.correlationId),
      transactionId: props.transactionId && UUID.test(props.transactionId) ? props.transactionId : undefined,
      detail: props.detail?.replace(/\s+/g, " ").slice(0, 500),
    });
  }

  static rehydrate(state: SubmissionFailureState): SubmissionFailure {
    return new SubmissionFailure(state);
  }

  get id() {
    return this.state.id;
  }
  get channel() {
    return this.state.channel;
  }
  get reasonCode() {
    return this.state.reasonCode;
  }
  get category() {
    return this.state.category;
  }
  get retryable() {
    return this.state.retryable;
  }
  get providerId() {
    return this.state.providerId;
  }
  get externalTransactionId() {
    return this.state.externalTransactionId;
  }
  get idempotencyKey() {
    return this.state.idempotencyKey;
  }
  get walletId() {
    return this.state.walletId;
  }
  get messageId() {
    return this.state.messageId;
  }
  get transactionId() {
    return this.state.transactionId;
  }
  get payloadHash() {
    return this.state.payloadHash;
  }
  get detail() {
    return this.state.detail;
  }
  get receiveCount() {
    return this.state.receiveCount;
  }
  get correlationId() {
    return this.state.correlationId;
  }
  get occurredAt() {
    return this.state.occurredAt;
  }

  toState(): SubmissionFailureState {
    return { ...this.state };
  }
}
