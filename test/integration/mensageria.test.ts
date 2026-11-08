import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { carregarConfiguracao } from '../../src/config';
import { PublicadorOutboxWorker } from '../../src/workers/publicador-outbox.worker';
import { UrlsDasFilas } from '../../src/utils/cliente-sqs';
import { MetricasService } from '../../src/utils/metricas.service';
import { Logger } from '../../src/utils/logger';
import { UnidadeDeTrabalho } from '../../src/repositories/unidade-de-trabalho';
import { criarOrm, Orm } from '../../src/database/mikro-orm.config';
import {
  contar,
  criarFilas,
  criarCarteira,
  esvaziarFila,
  conferirSaldoComExtrato,
  prepararBanco,
  mensagensNaFila,
  AppRodando,
  enviarApostaPelaFila,
  clienteSqs,
  iniciarApp,
  TEST_DATABASE_URL,
  ambienteDeTeste,
  prefixoUnico,
  esperarAte,
  montarAposta,
} from '../support/ambiente';

let orm: Orm;
let app: AppRodando;
let filas: UrlsDasFilas;
const prefixo = prefixoUnico('msg');
const carteirasUsadas: string[] = [];

beforeAll(async () => {
  orm = await prepararBanco();
  filas = await criarFilas(prefixo);
  // sem o worker de outbox aqui: o teste de publishers concorrentes controla isso
  app = await iniciarApp(prefixo, {
    WORKERS: 'consumer,pending-references',
    DB_LOCK_TIMEOUT_MS: '300',
    SQS_MAX_ATTEMPTS: '3',
  });
});
afterAll(async () => {
  for (const walletId of carteirasUsadas) await conferirSaldoComExtrato(orm, walletId);
  await app?.fechar();
  await orm?.close();
});

async function novaCarteira(valor: string) {
  const carteira = await criarCarteira(app.url, valor);
  carteirasUsadas.push(carteira.walletId);
  return carteira;
}

const statusDaTransacao = async (externalId: string) => {
  const [linha] = await orm.em.fork().execute(`select status from wager_transactions where external_transaction_id = ?`, [externalId]);
  return linha?.status as string | undefined;
};

describe('consumer SQS', () => {
  test('processa a mensagem pelo mesmo caso de uso e grava o inbox', async () => {
    const carteira = await novaCarteira('100.00');
    const aposta = montarAposta(carteira, 'BET', '10.00');
    const messageId = await enviarApostaPelaFila(filas.apostas, aposta);
    await esperarAte(async () => (await statusDaTransacao(aposta.externalTransactionId)) === 'PROCESSED');
    expect(await contar(orm, 'select 1 from inbox_messages where message_id = ?', [messageId])).toBe(1);
    await esperarAte(async () => (await mensagensNaFila(filas.apostas)) === 0);
  });

  test('redelivery do mesmo messageId não duplica efeito', async () => {
    const carteira = await novaCarteira('100.00');
    const aposta = montarAposta(carteira, 'BET', '10.00');
    const messageId = crypto.randomUUID();
    await Promise.all([
      enviarApostaPelaFila(filas.apostas, aposta, messageId),
      enviarApostaPelaFila(filas.apostas, aposta, messageId),
      enviarApostaPelaFila(filas.apostas, aposta, messageId),
    ]);
    await esperarAte(async () => (await mensagensNaFila(filas.apostas)) === 0);
    expect(await contar(orm, 'select 1 from wallet_ledger_entries where wallet_id = ? and direction = ?', [carteira.walletId, 'DEBIT'])).toBe(1);
    expect(await conferirSaldoComExtrato(orm, carteira.walletId)).toBe('90.00');
  });

  test('rejeição de negócio é terminal: ack sem retry', async () => {
    const carteira = await novaCarteira('5.00');
    const aposta = montarAposta(carteira, 'BET', '10.00');
    await enviarApostaPelaFila(filas.apostas, aposta);
    await esperarAte(async () => (await statusDaTransacao(aposta.externalTransactionId)) === 'REJECTED');
    await esperarAte(async () => (await mensagensNaFila(filas.apostas)) === 0);
  });

  test('mensagem inválida vai direto para a DLQ', async () => {
    await clienteSqs().send(
      new SendMessageCommand({
        QueueUrl: filas.apostas,
        MessageBody: '{"isto": "não é um envelope válido"}',
        MessageGroupId: 'poison',
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );
    await esperarAte(async () => (await mensagensNaFila(filas.dlqDeApostas)) >= 1);
    const dlq = await esvaziarFila(filas.dlqDeApostas);
    expect(dlq.some((m) => m.isto)).toBe(true);
  });

  test('falha transitória: retry com backoff e sucesso quando a infra volta', async () => {
    const carteira = await novaCarteira('100.00');
    const bloqueador = orm.em.fork();
    await bloqueador.begin();
    await bloqueador.execute('select 1 from wallets where id = ? for update', [carteira.walletId]); // lock_timeout no app
    const aposta = montarAposta(carteira, 'BET', '10.00');
    await enviarApostaPelaFila(filas.apostas, aposta);
    await Bun.sleep(1_000);
    expect(await statusDaTransacao(aposta.externalTransactionId)).toBeUndefined();
    await bloqueador.commit();
    await esperarAte(async () => (await statusDaTransacao(aposta.externalTransactionId)) === 'PROCESSED', 20_000);
  });

  test('esgotado o limite de tentativas, a mensagem vai para a DLQ', async () => {
    const carteira = await novaCarteira('100.00');
    const bloqueador = orm.em.fork();
    await bloqueador.begin();
    await bloqueador.execute('select 1 from wallets where id = ? for update', [carteira.walletId]);
    try {
      const aposta = montarAposta(carteira, 'BET', '10.00');
      await enviarApostaPelaFila(filas.apostas, aposta);
      // tentativas: 1ª, +2s, +4s → 3ª falha → DLQ
      await esperarAte(async () => (await esvaziarFila(filas.dlqDeApostas, 1_000)).some((m) => m.data?.externalTransactionId === aposta.externalTransactionId), 30_000, 500);
      expect(await statusDaTransacao(aposta.externalTransactionId)).toBeUndefined();
    } finally {
      await bloqueador.rollback();
    }
  });
});

describe('outbox', () => {
  test('dois publishers concorrentes: todos os eventos publicados, nenhum perdido', async () => {
    const agregado = crypto.randomUUID();
    const ids = Array.from({ length: 40 }, () => crypto.randomUUID());
    for (const id of ids) {
      await orm.em.fork().execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         values (?, ?, 'TestEvent', ?, now(), 0, now())`,
        [id, agregado, JSON.stringify({ eventId: id, eventType: 'TestEvent', data: { aggregate: agregado } })],
      );
    }

    const cfg = carregarConfiguracao(ambienteDeTeste(prefixo));
    const ormA = await criarOrm(TEST_DATABASE_URL, 3);
    const ormB = await criarOrm(TEST_DATABASE_URL, 3);
    // dois publishers independentes (conexões separadas), como em duas instâncias
    const publicador = (o: Orm) =>
      new PublicadorOutboxWorker(new UnidadeDeTrabalho(o, new MetricasService(), cfg), clienteSqs(), filas, new MetricasService(), new Logger('silent'), cfg);
    const publicadorA = publicador(ormA);
    const publicadorB = publicador(ormB);
    try {
      await Promise.all([publicadorA.publicarPendentes(10), publicadorB.publicarPendentes(10), publicadorA.publicarPendentes(10), publicadorB.publicarPendentes(10)]);
      await esperarAte(async () => {
        await Promise.all([publicadorA.publicarPendentes(50), publicadorB.publicarPendentes(50)]);
        return (await contar(orm, 'select 1 from outbox_messages where aggregate_id = ? and published_at is null', [agregado])) === 0;
      });
      const recebidos = (await esvaziarFila(filas.eventos)).filter((erro) => erro.data?.aggregate === agregado).map((erro) => erro.eventId);
      expect(new Set(recebidos)).toEqual(new Set(ids));
    } finally {
      await ormA.close();
      await ormB.close();
    }
  });
});
