# Architecture

## Design

NestJS exposes the HTTP API and runs background SQS/outbox workers. TypeORM is used as a PostgreSQL connection and transaction boundary; financial statements use parameterized SQL so the row lock and ordering are visible. `Money` uses `decimal.js`; HTTP money is accepted only as a non-negative decimal string with exactly two fractional digits. The idempotency payload is SHA-256 over recursively key-sorted JSON of business fields, excluding headers and transport metadata.

Every wager executes in one PostgreSQL transaction. It locks the wallet row with `SELECT ... FOR UPDATE`, writes transaction status, balance, immutable ledger row, and outbox event before commit. This serializes a hot wallet across application instances while allowing unrelated wallets to proceed independently. Database unique constraints protect player/currency wallets, provider/external IDs, idempotency keys, and one ledger movement per transaction. SQL checks protect nonnegative balances and ledger arithmetic; a trigger rejects ledger updates and deletes.

SQS consumption records the inbox key and performs the financial operation in the same SQL transaction. The worker deletes the message only after that transaction commits. Outbox publishers claim rows with `FOR UPDATE SKIP LOCKED`, publish after claim, and mark success only after SQS accepts the message; a crash can cause a duplicate publication, so consumers must deduplicate by event ID. SQS is not the consistency boundary.

## Authentication

Authentication is intentionally omitted to prioritize the financial invariants, as permitted by the challenge. Provider identity is still checked against the wallet/player and reference transaction. In production, an OIDC provider such as Keycloak should issue provider-scoped credentials; a Nest guard would validate issuer, audience, signature and provider claim before allowing wagering routes. Health endpoints remain public.

## State transitions and failure codes

Accepted wagers start `PENDING`; reference-dependent operations with no reference enter `PENDING_REFERENCE`; successful operations become `PROCESSED`; business rules produce terminal `REJECTED`; permanent processing defects may be recorded as `FAILED`. Rejected codes include `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_INVALID`, `REFERENCE_ALREADY_REVERSED`, and `WALLET_MISMATCH`. Infrastructure failures roll back and are retried by SQS. `OPENING` is internal and creates a matching credit entry.

## Limits and follow-up

The automated suite covers Money and wallet domain rules, PostgreSQL idempotency and hot-wallet races (including 50 duplicate sends), business reversals and invalid references, out-of-order refunds, retry exhaustion, inbox redelivery, three concurrent API processes, DLQ redrive, independent-wallet processing, database ledger constraints, HTTP status mapping, and concurrent outbox publishers. It kills a consumer after commit but before SQS ack, verifies restart redelivery, sends SIGTERM while a committed message is in flight, and kills a publisher while it holds an outbox lease before checking recovery. Migrations are applied and reverted in an isolated schema during integration tests. Reconciliation mismatch logging and metrics, retry backoff, and final wallet-to-ledger consistency are also tested. Metrics are process-local and should be exported to a shared monitoring system for multi-instance aggregation. The ledger API uses an opaque keyset cursor. Authentication and OpenTelemetry are out of scope per the permitted challenge choices.

## Local database lifecycle

PostgreSQL and LocalStack are defined as Docker Compose services. Creating the files does not create a database on the host. Running `docker compose up -d postgres localstack` downloads container images if needed and starts isolated containers; the database files remain in the container unless a volume is added. The API connection URL points to the Compose network. Apply the reversible migration only after reviewing the SQL and explicitly starting the services.
