import { IsolationLevel } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { ErroDeConcorrencia, ErroHttp } from '../utils/erros';
import { Logger } from '../utils/logger';
import { MetricasService } from '../utils/metricas.service';
import { novoId } from '../utils/utilitarios';
import { ehUuid } from '../utils/validacao';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { CriarCarteiraDto } from '../dto/criar-carteira.dto';
import { type Repositorios, UnidadeDeTrabalho } from '../repositories/unidade-de-trabalho';

export interface PaginaDoExtrato {
  lancamentos: WalletLedgerEntry[];
  proximoCursor: string | null; // null = última página
}

export interface Reconciliacao {
  carteira: Wallet;
  saldoCalculado: Money; // soma do ledger
  diferenca: Money; // saldo gravado - saldo calculado
  consistente: boolean;
  lancamentosConferidos: number;
}

@Injectable()
export class CarteirasService {
  constructor(
    private readonly unidadeDeTrabalho: UnidadeDeTrabalho,
    private readonly metricas: MetricasService,
    private readonly logger: Logger,
  ) {}

  /**
   * Cria a wallet. Se o saldo inicial for > 0, cria também a transação interna
   * OPENING com o lançamento CREDIT — tudo na mesma transação SQL.
   */
  async criar(dto: CriarCarteiraDto, correlationId: string): Promise<Wallet> {
    const saldoInicial = Money.from(dto.initialBalance);
    try {
      const carteira = await this.unidadeDeTrabalho.executar(async (repos) => {
        const agora = new Date();
        const { wallet: carteira, openingEntry: lancamentoDeAbertura } = Wallet.open({
          id: novoId(),
          playerId: dto.playerId,
          initialBalance: saldoInicial,
          openingTransactionId: novoId(),
          openingEntryId: novoId(),
          at: agora,
        });
        await repos.carteiras.inserir(carteira);
        if (lancamentoDeAbertura) {
          await this.registrarAbertura(repos, carteira, lancamentoDeAbertura, correlationId, agora);
        }
        return carteira;
      });
      this.logger.info({ walletId: carteira.id }, 'wallet criada');
      return carteira;
    } catch (erro) {
      // o banco garante uma wallet por jogador + moeda (UNIQUE)
      if (erro instanceof ErroDeConcorrencia && erro.restricao === 'wallets_player_id_currency_key') {
        throw new ErroHttp(409, 'WALLET_ALREADY_EXISTS', `jogador já tem wallet em ${saldoInicial.currency}`);
      }
      throw erro;
    }
  }

  /** Busca a wallet; 404 se não existir. */
  async buscar(walletId: string): Promise<Wallet> {
    return this.unidadeDeTrabalho.executar((repos) => this.buscarCarteira(repos, walletId));
  }

  /**
   * Ledger paginado. O cursor é a última versão da wallet vista, em base64 —
   * como a versão só cresce, a paginação não pula nem repete itens.
   */
  async extrato(walletId: string, cursor: string | undefined, limite: number): Promise<PaginaDoExtrato> {
    if (!Number.isInteger(limite) || limite < 1 || limite > 200) {
      throw new ErroHttp(400, 'VALIDATION_ERROR', 'limit deve estar entre 1 e 200');
    }
    const depoisDaVersao = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
    if (!Number.isSafeInteger(depoisDaVersao) || depoisDaVersao < 0) {
      throw new ErroHttp(400, 'VALIDATION_ERROR', 'cursor inválido');
    }

    const encontrados = await this.unidadeDeTrabalho.executar(async (repos) => {
      await this.buscarCarteira(repos, walletId);
      // busca 1 a mais para saber se há próxima página
      return repos.lancamentos.pagina(walletId, depoisDaVersao, limite + 1);
    });
    const lancamentos = encontrados.slice(0, limite);
    const temMais = encontrados.length > limite;
    const ultimaVersao = lancamentos.at(-1)?.walletVersion;
    return {
      lancamentos,
      proximoCursor: temMais ? Buffer.from(String(ultimaVersao)).toString('base64url') : null,
    };
  }

  /**
   * Confere se o saldo gravado bate com o saldo calculado pelo ledger.
   * Não corrige nada: se divergir, registra log de erro, métrica e avisa na resposta.
   */
  async reconciliar(walletId: string): Promise<Reconciliacao> {
    // REPEATABLE READ: wallet e ledger lidos no mesmo instante
    const { carteira, extrato } = await this.unidadeDeTrabalho.executar(async (repos) => {
      const carteira = await this.buscarCarteira(repos, walletId);
      const extrato = await repos.lancamentos.saldoPeloExtrato(walletId, carteira.currency);
      return { carteira, extrato };
    }, IsolationLevel.REPEATABLE_READ);

    const diferenca = carteira.balance.subtract(extrato.saldo);
    const consistente = diferenca.isZero();
    if (!consistente) {
      this.metricas.divergenciasDeReconciliacao.inc();
      this.logger.error({ walletId, difference: diferenca.amount }, 'saldo diferente do ledger');
    }
    return {
      carteira,
      saldoCalculado: extrato.saldo,
      diferenca,
      consistente,
      lancamentosConferidos: extrato.quantidade,
    };
  }

  /** Grava a transação OPENING, o lançamento de crédito inicial e os eventos. */
  private async registrarAbertura(
    repos: Repositorios,
    carteira: Wallet,
    lancamento: WalletLedgerEntry,
    correlationId: string,
    agora: Date,
  ): Promise<void> {
    const abertura = WagerTransaction.create({
      id: lancamento.transactionId,
      providerId: 'internal',
      externalTransactionId: `opening:${carteira.id}`,
      idempotencyKey: `internal:opening:${carteira.id}`,
      payloadHash: '-',
      walletId: carteira.id,
      playerId: carteira.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: lancamento.money,
      correlationId,
      createdAt: agora,
    });
    abertura.markProcessed(undefined, agora, carteira.balance);
    await repos.transacoes.inserir(abertura);
    await repos.lancamentos.adicionar(lancamento);

    const contexto = () => ({ eventId: novoId(), correlationId, occurredAt: agora });
    await repos.outbox.adicionar([
      OutboxMessage.enqueue(WagerTransactionProcessed.from(abertura, contexto())),
      OutboxMessage.enqueue(WalletBalanceChanged.from(carteira, lancamento, contexto())),
    ]);
  }

  /** Busca dentro de uma transação já aberta; 404 se não existir. */
  private async buscarCarteira(repos: Repositorios, walletId: string): Promise<Wallet> {
    const carteira = ehUuid(walletId) ? await repos.carteiras.buscarPorId(walletId) : undefined;
    if (!carteira) throw new ErroHttp(404, 'NOT_FOUND', 'wallet não encontrada');
    return carteira;
  }
}
