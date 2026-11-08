import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { expect } from 'bun:test';
import type { Subprocess } from 'bun';
import { Configuracao, carregarConfiguracao } from '../../src/config';
import { iniciarAplicacao } from '../../src/main';
import { garantirFilas, UrlsDasFilas } from '../../src/utils/cliente-sqs';
import { criarOrm, Orm } from '../../src/database/mikro-orm.config';

/**
 * Testes de integração usam PostgreSQL e SQS REAIS (docker compose up -d postgres sqs).
 * Cada arquivo usa um prefixo próprio de filas, então não há interferência entre eles.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';
export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function esperarAte(verificacao: () => Promise<boolean> | boolean, limiteMs = 30_000, intervaloMs = 150) {
  const prazo = Date.now() + limiteMs;
  while (Date.now() < prazo) {
    if (await Promise.resolve().then(verificacao).catch(() => false)) return;
    await dormir(intervaloMs);
  }
  throw new Error(`condição não atendida em ${limiteMs}ms`);
}

/** Cria o banco de teste se preciso e aplica as migrations. */
export async function prepararBanco(url = TEST_DATABASE_URL): Promise<Orm> {
  const nome = url.split('/').pop()!;
  const admin = await criarOrm(url.replace(/\/[^/]+$/, '/postgres'), 1);
  const jaExiste = await admin.em.fork().execute('select 1 from pg_database where datname = ?', [nome]);
  if (jaExiste.length === 0) await admin.em.fork().execute(`create database "${nome}"`);
  await admin.close();
  const orm = await criarOrm(url, 10);
  await orm.getMigrator().up();
  return orm;
}

/** Variáveis de ambiente de uma instância de teste (mesmo formato do container). */
export function ambienteDeTeste(prefixo: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    SQS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAGER_QUEUE: `${prefixo}-wager.fifo`,
    SQS_WAGER_DLQ: `${prefixo}-wager-dlq.fifo`,
    SQS_EVENTS_QUEUE: `${prefixo}-events.fifo`,
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    SQS_MAX_ATTEMPTS: '3',
    OUTBOX_POLL_MS: '200',
    PENDING_REFERENCE_POLL_MS: '200',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
    LOG_LEVEL: 'warn',
    ...extra,
  };
}

export function prefixoUnico(nome: string) {
  return `t-${nome}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function clienteSqs() {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

/** Cria as filas com a mesma configuração que a instância vai usar. */
export async function criarFilas(prefixo: string, extra: Record<string, string> = {}): Promise<UrlsDasFilas> {
  return garantirFilas(clienteSqs(), carregarConfiguracao(ambienteDeTeste(prefixo, extra)).sqs);
}

// ------------------------------------------------------------------ app em processo
export interface AppRodando {
  url: string;
  config: Configuracao;
  fechar(): Promise<void>;
}

export async function iniciarApp(prefixo: string, extra: Record<string, string> = {}): Promise<AppRodando> {
  const config = { ...carregarConfiguracao(ambienteDeTeste(prefixo, extra)), porta: 0 };
  const app = await iniciarAplicacao(config);
  const endereco = app.getHttpServer().address() as { port: number };
  return { url: `http://localhost:${endereco.port}`, config, fechar: () => app.close() };
}

// ------------------------------------------------------------------ app como processo separado
export interface Instancia {
  url: string;
  processo: Subprocess;
  encerrar(sinal?: NodeJS.Signals): Promise<void>;
}

let proximaPorta = 4100 + Math.floor(Math.random() * 500);

export async function subirInstancia(env: Record<string, string>, esperarPronto = true): Promise<Instancia> {
  const porta = proximaPorta++;
  const processo = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    env: { ...process.env, ...env, PORT: String(porta) },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const url = `http://localhost:${porta}`;
  if (esperarPronto) {
    await esperarAte(async () => (await fetch(`${url}/health/ready`)).ok, 60_000, 300);
  }
  return {
    url,
    processo,
    async encerrar(sinal: NodeJS.Signals = 'SIGKILL') {
      processo.kill(sinal);
      await processo.exited;
    },
  };
}

// ------------------------------------------------------------------ HTTP
export async function http(url: string, metodo: string, path: string, corpo?: unknown, cabecalhos: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : undefined };
}

export async function criarCarteira(url: string, valor: string, moeda = 'BRL') {
  const playerId = crypto.randomUUID();
  const res = await http(url, 'POST', '/wallets', { playerId, initialBalance: { amount: valor, currency: moeda } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

let contadorExterno = 0;
export function montarAposta(
  carteira: { walletId: string; playerId: string },
  tipo: string,
  valor: string,
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${Date.now()}-${++contadorExterno}-${Math.random().toString(36).slice(2, 8)}`,
    playerId: carteira.playerId,
    walletId: carteira.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: tipo,
    money: { amount: valor, currency: 'BRL' },
    ...extra,
  };
}

export function enviarAposta(url: string, dados: { providerId: string; externalTransactionId: string; [k: string]: unknown }, chave?: string) {
  return http(url, 'POST', '/wagering/transactions', dados, {
    'idempotency-key': chave ?? `${dados.providerId}:${dados.externalTransactionId}`,
  });
}

// ------------------------------------------------------------------ SQS
export async function enviarApostaPelaFila(queueUrl: string, dados: Record<string, unknown>, messageId = crypto.randomUUID()) {
  await clienteSqs().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { idempotencyKey: `${dados.providerId}:${dados.externalTransactionId}`, ...dados },
      }),
      MessageGroupId: String(dados.walletId),
      // dedup do broker desligado na prática: queremos testar o inbox, não o SQS
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  return messageId;
}

export async function mensagensNaFila(queueUrl: string): Promise<number> {
  const res = await clienteSqs().send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

/** Lê tudo que estiver disponível numa fila (para inspecionar eventos e DLQ). */
export async function esvaziarFila(queueUrl: string, esperaMs = 3_000): Promise<Array<Record<string, any>>> {
  const saida: Array<Record<string, any>> = [];
  const prazo = Date.now() + esperaMs;
  while (Date.now() < prazo) {
    const res = await clienteSqs().send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60 }),
    );
    for (const m of res.Messages ?? []) {
      saida.push(JSON.parse(m.Body ?? '{}'));
      // FIFO: o grupo só libera a próxima mensagem depois que esta é apagada
      await clienteSqs().send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  return saida;
}

// ------------------------------------------------------------------ invariantes
/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function conferirSaldoComExtrato(orm: Orm, walletId: string) {
  const [linha] = await orm.em.fork().execute<{ balance: string; ledger: string }[]>(
    `select w.balance::text as balance,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.balance`,
    [walletId],
  );
  expect(linha).toBeDefined();
  expect(linha!.balance).toBe(linha!.ledger);
  return linha!.balance;
}

export async function contar(orm: Orm, sql: string, parametros: unknown[] = []): Promise<number> {
  const [linha] = await orm.em.fork().execute<{ n: number }[]>(`select count(*)::int as n from (${sql}) q`, parametros);
  return linha?.n ?? 0;
}
