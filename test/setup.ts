// Carregado antes de qualquer teste (bunfig.toml). Define o ambiente ANTES de src/config.ts ser importado.
// Os testes usam infraestrutura real (Postgres e LocalStack do docker-compose), em banco e filas próprios.
const base = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
process.env.ADMIN_DATABASE_URL = base;
process.env.DATABASE_URL = base.replace(/\/[^/]+$/, '/wagering_test');
process.env.QUEUE_PREFIX = `test-${Date.now()}-`;
process.env.LOG_LEVEL ??= 'silent';
process.env.SQS_WAIT_TIME_SECONDS = '1';
process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = '2';
process.env.SQS_MAX_RECEIVE_COUNT = '3';
process.env.SQS_MAX_RETRY_DELAY_SECONDS = '1';
process.env.OUTBOX_POLL_MS = '50';
process.env.PENDING_REFERENCE_POLL_MS = '100';
