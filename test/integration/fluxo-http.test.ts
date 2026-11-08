import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Orm } from '../../src/database/mikro-orm.config';
import { UrlsDasFilas } from "../../src/utils/cliente-sqs";
import {
  contar,
  criarFilas,
  criarCarteira,
  esvaziarFila,
  conferirSaldoComExtrato,
  http,
  prepararBanco,
  AppRodando,
  iniciarApp,
  enviarAposta,
  prefixoUnico,
  esperarAte,
  montarAposta,
} from '../support/ambiente';

let orm: Orm;
let app: AppRodando;
let filas: UrlsDasFilas;
const prefixo = prefixoUnico('http');
const carteirasUsadas: string[] = [];

beforeAll(async () => {
  orm = await prepararBanco();
  filas = await criarFilas(prefixo);
  app = await iniciarApp(prefixo);
});
afterAll(async () => {
  for (const walletId of carteirasUsadas) await conferirSaldoComExtrato(orm, walletId);
  await app?.fechar();
  await orm?.close();
});

async function novaCarteira(valor = '100.00') {
  const carteira = await criarCarteira(app.url, valor);
  carteirasUsadas.push(carteira.walletId);
  return carteira;
}

describe('wallets', () => {
  test('criação com saldo inicial gera OPENING + CREDIT no ledger', async () => {
    const carteira = await novaCarteira('1000.00');
    const res = await http(app.url, 'GET', `/wallets/${carteira.walletId}`);
    expect(res.body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(res.body.version).toBe(1);
    const extrato = await http(app.url, 'GET', `/wallets/${carteira.walletId}/ledger`);
    expect(extrato.body.items).toHaveLength(1);
    expect(extrato.body.items[0]).toMatchObject({ direction: 'CREDIT', walletVersion: 1 });
  });

  test('wallet duplicada para o mesmo player + moeda → 409', async () => {
    const carteira = await novaCarteira();
    const res = await http(app.url, 'POST', '/wallets', { playerId: carteira.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('payload inválido → 400 (amount como number)', async () => {
    const res = await http(app.url, 'POST', '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET processada, replay idêntico e conflito de payload', async () => {
    const carteira = await novaCarteira('1000.00');
    const aposta = montarAposta(carteira, 'BET', '25.00');
    const primeira = await enviarAposta(app.url, aposta);
    expect(primeira.status).toBe(200);
    expect(primeira.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00' }, idempotentReplay: false });

    const repeticao = await enviarAposta(app.url, aposta);
    expect(repeticao.status).toBe(200);
    expect(repeticao.body).toEqual({ ...primeira.body, idempotentReplay: true });

    const conflito = await enviarAposta(app.url, { ...aposta, money: { amount: '30.00', currency: 'BRL' } });
    expect(conflito.status).toBe(409);
    expect(conflito.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await contar(orm, 'select 1 from wallet_ledger_entries where wallet_id = ?', [carteira.walletId])).toBe(2);
  });

  test('replay devolve o saldo observado naquele momento, não o atual', async () => {
    const carteira = await novaCarteira('100.00');
    const aposta = montarAposta(carteira, 'BET', '10.00');
    await enviarAposta(app.url, aposta);
    await enviarAposta(app.url, montarAposta(carteira, 'BET', '50.00'));
    const repeticao = await enviarAposta(app.url, aposta);
    expect(repeticao.body.balance.amount).toBe('90.00');
  });

  test('distingue 400, 422 e 404 de forma consistente', async () => {
    const carteira = await novaCarteira('10.00');
    const semChave = await http(app.url, 'POST', '/wagering/transactions', montarAposta(carteira, 'BET', '1.00'));
    expect(semChave.status).toBe(400);
    expect((await enviarAposta(app.url, montarAposta(carteira, 'BET', '1.005'))).status).toBe(400);
    expect((await enviarAposta(app.url, montarAposta(carteira, 'OPENING', '1.00'))).status).toBe(400);

    const semSaldo = await enviarAposta(app.url, montarAposta(carteira, 'BET', '10.01'));
    expect(semSaldo.status).toBe(422);
    expect(semSaldo.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });

    const inexistente = await enviarAposta(app.url, montarAposta({ walletId: crypto.randomUUID(), playerId: carteira.playerId }, 'BET', '1.00'));
    expect(inexistente.status).toBe(422);
    expect(inexistente.body.failureCode).toBe('WALLET_NOT_FOUND');

    expect((await http(app.url, 'GET', `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  });

  test('WIN, LOSS, REFUND e ROLLBACK', async () => {
    const carteira = await novaCarteira('100.00');
    const aposta = montarAposta(carteira, 'BET', '40.00');
    await enviarAposta(app.url, aposta);
    const ganho = montarAposta(carteira, 'WIN', '15.00', { referenceExternalTransactionId: aposta.externalTransactionId });
    expect((await enviarAposta(app.url, ganho)).body.balance.amount).toBe('75.00');
    const perda = await enviarAposta(app.url, montarAposta(carteira, 'LOSS', '0.00'));
    expect(perda.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });

    const aposta2 = montarAposta(carteira, 'BET', '20.00');
    await enviarAposta(app.url, aposta2);
    const reembolso = montarAposta(carteira, 'REFUND', '20.00', { referenceExternalTransactionId: aposta2.externalTransactionId });
    expect((await enviarAposta(app.url, reembolso)).body.balance.amount).toBe('75.00');
    const segundoReembolso = await enviarAposta(app.url, montarAposta(carteira, 'REFUND', '20.00', { referenceExternalTransactionId: aposta2.externalTransactionId }));
    expect(segundoReembolso.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const estornoDoGanho = await enviarAposta(app.url, montarAposta(carteira, 'ROLLBACK', '15.00', { referenceExternalTransactionId: ganho.externalTransactionId }));
    expect(estornoDoGanho.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '60.00' } });

    // LOSS não gera lançamento: OPENING + BET + WIN + BET + REFUND + ROLLBACK = 6
    expect(await contar(orm, 'select 1 from wallet_ledger_entries where wallet_id = ?', [carteira.walletId])).toBe(6);
  });

  test('REFUND antes da BET: fica PENDING_REFERENCE (202) e o worker aplica depois', async () => {
    const carteira = await novaCarteira('100.00');
    const aposta = montarAposta(carteira, 'BET', '30.00');
    const reembolso = montarAposta(carteira, 'REFUND', '30.00', { referenceExternalTransactionId: aposta.externalTransactionId });
    const pendente = await enviarAposta(app.url, reembolso);
    expect(pendente.status).toBe(202);
    expect(pendente.body.status).toBe('PENDING_REFERENCE');

    await enviarAposta(app.url, aposta);
    await esperarAte(async () => (await enviarAposta(app.url, reembolso)).body.status === 'PROCESSED', 15_000);
    const transacao = await http(app.url, 'GET', `/providers/provider-a/wagering/transactions/${reembolso.externalTransactionId}`);
    expect(transacao.body.status).toBe('PROCESSED');
    expect((await http(app.url, 'GET', `/wallets/${carteira.walletId}`)).body.balance.amount).toBe('100.00');
  });
});

describe('consultas, reconciliação e eventos', () => {
  test('ledger paginado com cursor estável', async () => {
    const carteira = await novaCarteira('100.00');
    for (let i = 0; i < 5; i++) await enviarAposta(app.url, montarAposta(carteira, 'BET', '1.00'));
    const pagina1 = await http(app.url, 'GET', `/wallets/${carteira.walletId}/ledger?limit=4`);
    expect(pagina1.body.items).toHaveLength(4);
    expect(pagina1.body.nextCursor).toBeString();
    const pagina2 = await http(app.url, 'GET', `/wallets/${carteira.walletId}/ledger?limit=4&cursor=${pagina1.body.nextCursor}`);
    expect(pagina2.body.items).toHaveLength(2);
    expect(pagina2.body.nextCursor).toBeNull();
    expect(pagina2.body.items[0].walletVersion).toBe(pagina1.body.items[3].walletVersion + 1);
    expect((await http(app.url, 'GET', `/wallets/${carteira.walletId}/ledger?cursor=lixo`)).status).toBe(400);
  });

  test('reconciliação consistente', async () => {
    const carteira = await novaCarteira('975.00');
    await enviarAposta(app.url, montarAposta(carteira, 'BET', '10.00'));
    const res = await http(app.url, 'POST', `/wallets/${carteira.walletId}/reconciliation`);
    expect(res.body).toMatchObject({
      storedBalance: { amount: '965.00', currency: 'BRL' },
      calculatedBalance: { amount: '965.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('outbox publica os eventos depois do commit', async () => {
    const carteira = await novaCarteira('50.00');
    await enviarAposta(app.url, montarAposta(carteira, 'BET', '5.00'));
    await esperarAte(
      async () => (await contar(orm, `select 1 from outbox_messages where published_at is null and payload->'data'->>'walletId' = ?`, [carteira.walletId])) === 0,
    );
    const eventos = (await esvaziarFila(filas.eventos)).filter(
      (erro) => erro.data?.walletId === carteira.walletId,
    );
    const tipos = eventos.map((erro) => erro.eventType).sort();
    expect(tipos).toContain('WagerTransactionProcessed');
    expect(tipos).toContain('WalletBalanceChanged');
  });

  test('health checks', async () => {
    expect((await http(app.url, 'GET', '/health/live')).status).toBe(200);
    const pronto = await http(app.url, 'GET', '/health/ready');
    expect(pronto.body).toEqual({ status: 'ok', postgres: 'up', sqs: 'up' });
  });
});
