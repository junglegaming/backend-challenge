export const CONFIGURACAO = Symbol('APP_CONFIG');

export type TipoDeWorker = 'consumer' | 'outbox' | 'pending-references';

export interface Configuracao {
  porta: number;
  nivelDeLog: string;
  workers: Set<TipoDeWorker>;
  falhaSimulada?: 'crash-after-commit-before-ack' | 'crash-before-outbox-publish'; // só nos testes
  urlDoBanco: string;
  maxConexoesBanco: number;
  limiteDeLockMs: number;
  rodarMigrations: boolean;
  sqs: {
    endpoint: string;
    regiao: string;
    chaveDeAcesso: string;
    chaveSecreta: string;
    filaDeApostas: string;
    dlqDeApostas: string;
    filaDeEventos: string;
    nomeDoConsumidor: string;
    visibilidadeSegundos: number;
    maxTentativas: number;
  };
  intervaloOutboxMs: number;
  referenciaPendente: {
    intervaloMs: number;
    esperaInicialMs: number;
    esperaMaximaMs: number;
    prazoMaximoMs: number;
    maxTentativas: number;
  };
}

const numero = (valor: string | undefined, padrao: number) => (valor ? Number(valor) : padrao);

/**
 * Lê as variáveis de ambiente (lista completa no README) e aplica os valores
 * padrão. É o único lugar da aplicação que lê `process.env`.
 */
export function carregarConfiguracao(env: Record<string, string | undefined> = process.env): Configuracao {
  const workers = env.WORKERS ?? 'consumer,outbox,pending-references';
  return {
    porta: numero(env.PORT, 3000),
    nivelDeLog: env.LOG_LEVEL ?? 'info',
    workers: new Set(workers === 'none' ? [] : (workers.split(',').map((nome) => nome.trim()) as TipoDeWorker[])),
    falhaSimulada: (env.FAULT_INJECTION || undefined) as Configuracao['falhaSimulada'],
    urlDoBanco: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    maxConexoesBanco: numero(env.DB_POOL_MAX, 20),
    limiteDeLockMs: numero(env.DB_LOCK_TIMEOUT_MS, 5_000),
    rodarMigrations: env.RUN_MIGRATIONS === 'true',
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
      regiao: env.AWS_REGION ?? 'us-east-1',
      chaveDeAcesso: env.AWS_ACCESS_KEY_ID ?? 'test',
      chaveSecreta: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      filaDeApostas: env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
      dlqDeApostas: env.SQS_WAGER_DLQ ?? 'wager-transactions-dlq.fifo',
      filaDeEventos: env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
      nomeDoConsumidor: env.SQS_CONSUMER_NAME ?? 'wager-transactions-consumer',
      visibilidadeSegundos: numero(env.SQS_VISIBILITY_TIMEOUT_SECONDS, 30),
      maxTentativas: numero(env.SQS_MAX_ATTEMPTS, 5),
    },
    intervaloOutboxMs: numero(env.OUTBOX_POLL_MS, 500),
    referenciaPendente: {
      intervaloMs: numero(env.PENDING_REFERENCE_POLL_MS, 1_000),
      esperaInicialMs: numero(env.PENDING_REFERENCE_BASE_DELAY_MS, 1_000),
      esperaMaximaMs: numero(env.PENDING_REFERENCE_MAX_DELAY_MS, 60_000),
      prazoMaximoMs: numero(env.PENDING_REFERENCE_TTL_MS, 10 * 60_000),
      maxTentativas: numero(env.PENDING_REFERENCE_MAX_ATTEMPTS, 30),
    },
  };
}
