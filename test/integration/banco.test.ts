import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransactionProcessed } from '../../src/domain/events';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { Orm } from '../../src/database/mikro-orm.config';
import { UnidadeDeTrabalho } from '../../src/repositories/unidade-de-trabalho';
import { MetricasService } from '../../src/utils/metricas.service';
import { carregarConfiguracao } from '../../src/config';
import { contar, prepararBanco, TEST_DATABASE_URL } from '../support/ambiente';

let orm: Orm;
beforeAll(async () => {
  orm = await prepararBanco();
});
afterAll(async () => {
  await orm?.close();
});

const sql = (consulta: string, parametros: unknown[] = []) => orm.em.fork().execute(consulta, parametros);
const agora = () => new Date();

async function inserirCarteira(saldo = '100.00', playerId: string = crypto.randomUUID()) {
  const id = crypto.randomUUID();
  await sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'BRL', ?, 1, now(), now())`,
    [id, playerId, saldo],
  );
  return { id, playerId };
}

async function inserirTransacao(walletId: string, playerId: string, extra: Record<string, unknown> = {}) {
  const linha = {
    id: crypto.randomUUID(),
    provider_id: 'p',
    external_transaction_id: crypto.randomUUID(),
    idempotency_key: crypto.randomUUID(),
    payload_hash: 'h',
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'r',
    game_id: 'g',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PROCESSED',
    correlation_id: 'c',
    reference_transaction_id: null,
    reference_external_transaction_id: null,
    ...extra,
  };
  const colunas = Object.keys(linha);
  await sql(
    `insert into wager_transactions (${colunas.join(', ')}, created_at, updated_at) values (${colunas.map(() => '?').join(', ')}, now(), now())`,
    Object.values(linha),
  );
  return linha.id;
}

describe('migrations', () => {
  test('são reversíveis (down até o zero e up de novo)', async () => {
    const url = TEST_DATABASE_URL.replace(/\/[^/]+$/, '/wagering_migrations_test');
    const isolado = await prepararBanco(url);
    try {
      const migrador = isolado.getMigrator();
      await migrador.down({ to: 0 });
      expect(await migrador.getExecutedMigrations()).toHaveLength(0);
      const tabelas = await isolado.em.fork().execute(`select 1 from information_schema.tables where table_name = 'wallets'`);
      expect(tabelas).toHaveLength(0);
      await migrador.up();
      expect(await migrador.getPendingMigrations()).toHaveLength(0);
    } finally {
      await isolado.close();
    }
  });
});

describe('constraints no schema', () => {
  test('saldo negativo é recusado pelo banco', async () => {
    await expect(inserirCarteira('-0.01')).rejects.toThrow(/check/i);
  });

  test('uma wallet por playerId + currency', async () => {
    const { playerId } = await inserirCarteira();
    await expect(inserirCarteira('0.00', playerId)).rejects.toThrow(/wallets_player_id_currency_key/);
  });

  test('idempotency key e (provider, externalId) são únicos', async () => {
    const carteira = await inserirCarteira();
    const chave = crypto.randomUUID();
    await inserirTransacao(carteira.id, carteira.playerId, { idempotency_key: chave });
    await expect(inserirTransacao(carteira.id, carteira.playerId, { idempotency_key: chave })).rejects.toThrow(/idempotency_key_key/);
    await inserirTransacao(carteira.id, carteira.playerId, { external_transaction_id: 'dup-ext' + carteira.id });
    await expect(inserirTransacao(carteira.id, carteira.playerId, { external_transaction_id: 'dup-ext' + carteira.id })).rejects.toThrow(
      /provider_external_key/,
    );
  });

  test('REFUND/ROLLBACK sem referência é recusado', async () => {
    const carteira = await inserirCarteira();
    await expect(inserirTransacao(carteira.id, carteira.playerId, { kind: 'REFUND' })).rejects.toThrow(/reference_required/);
  });

  test('uma referência só pode ser revertida uma vez', async () => {
    const carteira = await inserirCarteira();
    const aposta = await inserirTransacao(carteira.id, carteira.playerId);
    const reversao = { reference_transaction_id: aposta, reference_external_transaction_id: 'x' };
    await inserirTransacao(carteira.id, carteira.playerId, { kind: 'REFUND', ...reversao });
    await expect(inserirTransacao(carteira.id, carteira.playerId, { kind: 'ROLLBACK', ...reversao })).rejects.toThrow(/single_reversal_key/);
  });

  test('ledger: aritmética, não-negatividade, versão única e imutabilidade', async () => {
    const carteira = await inserirCarteira();
    const transacao1 = await inserirTransacao(carteira.id, carteira.playerId);
    const transacao2 = await inserirTransacao(carteira.id, carteira.playerId);
    const lancamento = (txId: string, antes: string, valor: string, depois: string, versao: number) =>
      sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         values (?, ?, ?, 'DEBIT', ?, 'BRL', ?, ?, ?, now()) returning id`,
        [crypto.randomUUID(), carteira.id, txId, valor, antes, depois, versao],
      );

    await expect(lancamento(transacao1, '100.00', '10.00', '95.00', 2)).rejects.toThrow(/arithmetic/);
    await expect(lancamento(transacao1, '5.00', '10.00', '-5.00', 2)).rejects.toThrow(/check/i);
    const [ok] = await lancamento(transacao1, '100.00', '10.00', '90.00', 2);
    await expect(lancamento(transacao2, '90.00', '10.00', '80.00', 2)).rejects.toThrow(/wallet_version_key/);
    await expect(lancamento(transacao1, '90.00', '10.00', '80.00', 3)).rejects.toThrow(/wallet_transaction_key/);

    await expect(sql(`update wallet_ledger_entries set amount = 1 where id = ?`, [ok!.id])).rejects.toThrow(/imutável/);
    await expect(sql(`delete from wallet_ledger_entries where id = ?`, [ok!.id])).rejects.toThrow(/imutável/);
  });
});

describe('atomicidade', () => {
  test('wallet, transação, ledger e outbox: erro no meio → nada é gravado', async () => {
    const unidadeDeTrabalho = new UnidadeDeTrabalho(orm, new MetricasService(), carregarConfiguracao());
    const walletId = crypto.randomUUID();
    await expect(
      unidadeDeTrabalho.executar(async (repos) => {
        const { wallet: carteira, openingEntry: lancamentoDeAbertura } = Wallet.open({
          id: walletId,
          playerId: crypto.randomUUID(),
          initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
          openingTransactionId: crypto.randomUUID(),
          openingEntryId: crypto.randomUUID(),
          at: agora(),
        });
        await repos.carteiras.inserir(carteira);
        const transacao = WagerTransaction.create({
          id: lancamentoDeAbertura!.transactionId,
          providerId: 'internal',
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `internal:opening:${walletId}`,
          payloadHash: '-',
          walletId,
          playerId: carteira.playerId,
          roundId: 'r',
          gameId: 'g',
          kind: WagerTransactionKind.Opening,
          money: carteira.balance,
          correlationId: 'c',
          createdAt: agora(),
        });
        transacao.markProcessed(undefined, agora(), carteira.balance);
        await repos.transacoes.inserir(transacao);
        await repos.lancamentos.adicionar(lancamentoDeAbertura!);
        await repos.outbox.adicionar([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(transacao, { eventId: crypto.randomUUID(), correlationId: 'c', occurredAt: agora() })),
        ]);
        throw new Error('falha simulada antes do commit');
      }),
    ).rejects.toThrow('falha simulada');

    expect(await contar(orm, 'select 1 from wallets where id = ?', [walletId])).toBe(0);
    expect(await contar(orm, 'select 1 from wager_transactions where wallet_id = ?', [walletId])).toBe(0);
    expect(await contar(orm, 'select 1 from wallet_ledger_entries where wallet_id = ?', [walletId])).toBe(0);
    expect(await contar(orm, `select 1 from outbox_messages where payload->'data'->>'walletId' = ?`, [walletId])).toBe(0);
  });
});
