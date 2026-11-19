const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
const int = (name: string, fallback: number): number => Number.parseInt(env(name, String(fallback)), 10);

const queuePrefix = env('QUEUE_PREFIX', '');

export const config = {
  port: int('PORT', 3000),
  instanceId: env('INSTANCE_ID', `${process.pid}`),
  /** Papéis desta instância. Por padrão toda instância faz tudo. */
  roles: new Set(env('ROLES', 'api,consumer,workers').split(',')),
  databaseUrl: env('DATABASE_URL', 'postgres://wagering:wagering@localhost:5432/wagering'),
  lockTimeoutMs: int('LOCK_TIMEOUT_MS', 5000),
  sqs: {
    endpoint: env('SQS_ENDPOINT', 'http://localhost:4566'),
    region: env('AWS_REGION', 'us-east-1'),
    inputQueue: `${queuePrefix}wager-transactions.fifo`,
    dlq: `${queuePrefix}wager-transactions-dlq.fifo`,
    eventsQueue: `${queuePrefix}wager-events.fifo`,
    /** Recebimentos antes de o SQS mover a mensagem para a DLQ (redrive policy). */
    maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
    visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
    waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 2),
  },
  consumerName: 'wager-transactions-consumer',
  outbox: { pollMs: int('OUTBOX_POLL_MS', 250), batchSize: int('OUTBOX_BATCH_SIZE', 50) },
  pendingReference: {
    pollMs: int('PENDING_REFERENCE_POLL_MS', 500),
    batchSize: int('PENDING_REFERENCE_BATCH_SIZE', 50),
    /** Backoff 1s, 2s, 4s... Com 8 tentativas a referência tem ~4 min para chegar. */
    maxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 8),
  },
  shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 10_000),
};
