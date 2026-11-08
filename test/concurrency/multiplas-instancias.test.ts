import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UrlsDasFilas } from '../../src/utils/cliente-sqs';
import { Orm } from '../../src/database/mikro-orm.config';
import {
  contar,
  criarFilas,
  criarCarteira,
  conferirSaldoComExtrato,
  http,
  Instancia,
  prepararBanco,
  mensagensNaFila,
  enviarApostaPelaFila,
  subirInstancia,
  enviarAposta,
  ambienteDeTeste,
  prefixoUnico,
  esperarAte,
  montarAposta,
} from '../support/ambiente';

/**
 * Paralelismo real: 3 processos `bun run src/main.ts` independentes, cada um
 * com HTTP + consumer + outbox + worker de referências, no mesmo PostgreSQL e
 * nas mesmas filas. Nada é mockado.
 */
let orm: Orm;
let filas: UrlsDasFilas;
let instancias: Instancia[] = [];
const prefixo = prefixoUnico('conc');
const env = ambienteDeTeste(prefixo);
const carteirasUsadas: string[] = [];

const escolher = (i: number) => instancias[i % instancias.length]!.url;
const debitos = (walletId: string) =>
  contar(orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);

async function novaCarteira(valor: string) {
  const carteira = await criarCarteira(escolher(carteirasUsadas.length), valor);
  carteirasUsadas.push(carteira.walletId);
  return carteira;
}

beforeAll(async () => {
  orm = await prepararBanco();
  filas = await criarFilas(prefixo);
  instancias = await Promise.all([subirInstancia(env), subirInstancia(env), subirInstancia(env)]);
});

afterAll(async () => {
  await Promise.all(instancias.map((i) => i.encerrar()));
  // invariante final de todos os testes
  for (const walletId of carteirasUsadas) await conferirSaldoComExtrato(orm, walletId);
  await orm?.close();
});

describe('concorrência entre 3 instâncias', () => {
  test('cenário da seção 8: saldo 100, duas apostas de 80 simultâneas', async () => {
    const carteira = await novaCarteira('100.00');
    const [a, b] = [montarAposta(carteira, 'BET', '80.00'), montarAposta(carteira, 'BET', '80.00')];
    const resultados = await Promise.all([enviarAposta(escolher(0), a), enviarAposta(escolher(1), b)]);

    const listaDeStatus = resultados.map((r) => r.body.status).sort();
    expect(listaDeStatus).toEqual(['PROCESSED', 'REJECTED']);
    expect(resultados.find((r) => r.body.status === 'REJECTED')!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await conferirSaldoComExtrato(orm, carteira.walletId)).toBe('20.00');
    expect(await debitos(carteira.walletId)).toBe(1);

    // nenhum retry duplica o débito
    await Promise.all([enviarAposta(escolher(2), a), enviarAposta(escolher(0), b), enviarAposta(escolher(1), a)]);
    expect(await debitos(carteira.walletId)).toBe(1);
  });

  test('a mesma aposta enviada 50 vezes em paralelo → um único débito', async () => {
    const carteira = await novaCarteira('1000.00');
    const aposta = montarAposta(carteira, 'BET', '25.00');
    const resultados = await Promise.all(Array.from({ length: 50 }, (_, i) => enviarAposta(escolher(i), aposta)));

    expect(resultados.every((r) => r.status === 200)).toBe(true);
    expect(resultados.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(resultados.map((r) => r.body.transactionId)).size).toBe(1);
    expect(resultados.every((r) => r.body.balance.amount === '975.00')).toBe(true);
    expect(await debitos(carteira.walletId)).toBe(1);
  });

  test('hot wallet: 30 apostas de 1.00 contra saldo 20.00 → exatamente 20 aplicadas', async () => {
    const carteira = await novaCarteira('20.00');
    const resultados = await Promise.all(Array.from({ length: 30 }, (_, i) => enviarAposta(escolher(i), montarAposta(carteira, 'BET', '1.00'))));
    expect(resultados.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(20);
    expect(resultados.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(10);
    expect(await conferirSaldoComExtrato(orm, carteira.walletId)).toBe('0.00');
  });

  test('wallets distintas processadas em paralelo', async () => {
    const carteiras = await Promise.all(Array.from({ length: 10 }, () => novaCarteira('100.00')));
    await Promise.all(
      carteiras.flatMap((carteira, wi) => Array.from({ length: 10 }, (_, i) => enviarAposta(escolher(wi + i), montarAposta(carteira, 'BET', '3.50')))),
    );
    for (const carteira of carteiras) {
      expect(await conferirSaldoComExtrato(orm, carteira.walletId)).toBe('65.00');
    }
  });

  test('SQS: mensagens da mesma wallet consumidas pelas 3 instâncias sem saldo negativo', async () => {
    const carteira = await novaCarteira('10.00');
    await Promise.all(Array.from({ length: 15 }, () => enviarApostaPelaFila(filas.apostas, montarAposta(carteira, 'BET', '1.00'))));
    await esperarAte(async () => (await mensagensNaFila(filas.apostas)) === 0, 60_000);
    expect(await conferirSaldoComExtrato(orm, carteira.walletId)).toBe('0.00');
    expect(await debitos(carteira.walletId)).toBe(10);
  });

  test('ROLLBACK entregue antes da referência', async () => {
    const carteira = await novaCarteira('100.00');
    const aposta = montarAposta(carteira, 'BET', '40.00');
    const estorno = montarAposta(carteira, 'ROLLBACK', '40.00', { referenceExternalTransactionId: aposta.externalTransactionId });
    await enviarApostaPelaFila(filas.apostas, estorno);
    await esperarAte(async () => (await http(escolher(0), 'GET', `/providers/provider-a/wagering/transactions/${estorno.externalTransactionId}`)).body?.status === 'PENDING_REFERENCE');
    await enviarApostaPelaFila(filas.apostas, aposta);
    await esperarAte(
      async () => (await http(escolher(1), 'GET', `/providers/provider-a/wagering/transactions/${estorno.externalTransactionId}`)).body?.status === 'PROCESSED',
      30_000,
    );
    expect(await conferirSaldoComExtrato(orm, carteira.walletId)).toBe('100.00');
  });
});

describe('falhas de processo', () => {
  test('worker morto depois do commit e antes do ack: redelivery não duplica', async () => {
    const carteira = await novaCarteira('100.00');
    const prefixoDoCrash = prefixoUnico('crash');
    const extraDoCrash = { SQS_VISIBILITY_TIMEOUT_SECONDS: '2' };
    const filasDoCrash = await criarFilas(prefixoDoCrash, extraDoCrash);
    const ambienteDoCrash = ambienteDeTeste(prefixoDoCrash, extraDoCrash);

    const condenada = await subirInstancia({ ...ambienteDoCrash, FAULT_INJECTION: 'crash-after-commit-before-ack' });
    const aposta = montarAposta(carteira, 'BET', '10.00');
    await enviarApostaPelaFila(filasDoCrash.apostas, aposta);
    const codigoDeSaida = await condenada.processo.exited; // morre logo após o commit
    expect(codigoDeSaida).not.toBe(0);
    expect(await contar(orm, 'select 1 from wager_transactions where external_transaction_id = ?', [aposta.externalTransactionId])).toBe(1);
    expect(await mensagensNaFila(filasDoCrash.apostas)).toBe(1); // mensagem não foi confirmada

    const sobrevivente = await subirInstancia(ambienteDoCrash);
    try {
      await esperarAte(async () => (await mensagensNaFila(filasDoCrash.apostas)) === 0, 30_000);
      expect(await debitos(carteira.walletId)).toBe(1);
      expect(await conferirSaldoComExtrato(orm, carteira.walletId)).toBe('90.00');
    } finally {
      await sobrevivente.encerrar();
    }
  });


  test('reinício de todas as instâncias no meio da carga: consistência final comprovada', async () => {
    const carteiras = await Promise.all(Array.from({ length: 5 }, () => novaCarteira('50.00')));
    const carga = Promise.allSettled(
      carteiras.flatMap((carteira, wi) => Array.from({ length: 20 }, (_, i) => enviarAposta(escolher(wi + i), montarAposta(carteira, 'BET', '1.00')))),
    );
    await Bun.sleep(150);
    await Promise.all(instancias.map((i) => i.encerrar('SIGKILL')));
    await carga;

    instancias = await Promise.all([subirInstancia(env), subirInstancia(env), subirInstancia(env)]);
    for (const carteira of carteiras) {
      const reconciliacao = await http(escolher(0), 'POST', `/wallets/${carteira.walletId}/reconciliation`);
      expect(reconciliacao.body.consistent).toBe(true);
      await conferirSaldoComExtrato(orm, carteira.walletId);
    }
  });
});
