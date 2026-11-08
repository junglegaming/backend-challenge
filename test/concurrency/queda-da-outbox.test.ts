import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Orm } from '../../src/database/mikro-orm.config';
import {
  contar,
  criarFilas,
  criarCarteira,
  esvaziarFila,
  conferirSaldoComExtrato,
  prepararBanco,
  subirInstancia,
  enviarAposta,
  ambienteDeTeste,
  prefixoUnico,
  esperarAte,
  montarAposta,
} from '../support/ambiente';

/**
 * Arquivo separado de propósito: nenhum outro publisher pode estar vivo,
 * senão ele publicaria os eventos antes do processo que vamos derrubar.
 */
let orm: Orm;
beforeAll(async () => {
  orm = await prepararBanco();
});
afterAll(async () => {
  await orm?.close();
});

test('commit confirmado, processo morre antes de publicar, outra instância publica (duplicata segura)', async () => {
  const prefixo = prefixoUnico('outbox');
  const filas = await criarFilas(prefixo);
  const env = ambienteDeTeste(prefixo);

  // 1. só API: o commit grava a outbox, mas ninguém publica
  const api = await subirInstancia({ ...env, WORKERS: 'none' });
  const carteira = await criarCarteira(api.url, '30.00');
  await enviarAposta(api.url, montarAposta(carteira, 'BET', '5.00'));
  await api.encerrar();
  const pendente = () =>
    contar(orm, `select 1 from outbox_messages where published_at is null and payload->'data'->>'walletId' = ?`, [carteira.walletId]);
  expect(await pendente()).toBe(4); // abertura (2 eventos) + BET (2 eventos)

  // 2. publisher morre depois de travar o lote e antes de publicar
  const condenada = await subirInstancia({ ...env, WORKERS: 'outbox', FAULT_INJECTION: 'crash-before-outbox-publish' }, false);
  expect(await condenada.processo.exited).not.toBe(0);
  expect(await pendente()).toBe(4); // nada perdido, nada marcado

  // 3. outra instância assume e publica
  const saudavel = await subirInstancia({ ...env, WORKERS: 'outbox' });
  try {
    await esperarAte(async () => (await pendente()) === 0, 30_000);
  } finally {
    await saudavel.encerrar();
  }

  const eventos = (await esvaziarFila(filas.eventos)).filter((erro) => erro.data?.walletId === carteira.walletId);
  const ids = eventos.map((erro) => erro.eventId);
  // cada evento chega com eventId estável: um consumidor deduplica pelo id
  expect(new Set(ids).size).toBe(4);
  await conferirSaldoComExtrato(orm, carteira.walletId);
});
