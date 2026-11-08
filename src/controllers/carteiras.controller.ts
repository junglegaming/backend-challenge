import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AutenticacaoGuard } from '../utils/autenticacao.guard';
import { correlationIdAtual } from '../utils/logger';
import { validar } from '../utils/validacao';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import { schemaCriarCarteira } from '../dto/criar-carteira.dto';
import { CarteirasService } from '../services/carteiras.service';

@Controller('wallets')
@UseGuards(AutenticacaoGuard)
export class CarteirasController {
  constructor(private readonly carteirasService: CarteirasService) {}

  /** Cria a wallet com o saldo inicial. */
  @Post()
  async criar(@Body() corpo: unknown) {
    const carteira = await this.carteirasService.criar(validar(schemaCriarCarteira, corpo), correlationIdAtual());
    return carteiraParaResposta(carteira);
  }

  /** Saldo e versão atuais. */
  @Get(':walletId')
  async buscar(@Param('walletId') walletId: string) {
    return carteiraParaResposta(await this.carteirasService.buscar(walletId));
  }

  /** Extrato paginado: ?limit=50&cursor=<nextCursor da página anterior> */
  @Get(':walletId/ledger')
  async extrato(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limite?: string,
  ) {
    const pagina = await this.carteirasService.extrato(walletId, cursor || undefined, limite ? Number(limite) : 50);
    return {
      items: pagina.lancamentos.map(lancamentoParaResposta),
      nextCursor: pagina.proximoCursor,
    };
  }

  /** Compara o saldo gravado com a soma do ledger. */
  @Post(':walletId/reconciliation')
  async reconciliar(@Param('walletId') walletId: string) {
    const resultado = await this.carteirasService.reconciliar(walletId);
    return {
      walletId: resultado.carteira.id,
      storedBalance: resultado.carteira.balance.toJSON(),
      calculatedBalance: resultado.saldoCalculado.toJSON(),
      difference: resultado.diferenca.toJSON(),
      consistent: resultado.consistente,
      checkedEntries: resultado.lancamentosConferidos,
    };
  }
}

function carteiraParaResposta(carteira: Wallet) {
  return { id: carteira.id, playerId: carteira.playerId, balance: carteira.balance.toJSON(), version: carteira.version };
}

function lancamentoParaResposta(lancamento: WalletLedgerEntry) {
  return {
    id: lancamento.id,
    transactionId: lancamento.transactionId,
    direction: lancamento.direction,
    money: lancamento.money.toJSON(),
    balanceBefore: lancamento.balanceBefore.toJSON(),
    balanceAfter: lancamento.balanceAfter.toJSON(),
    walletVersion: lancamento.walletVersion,
    createdAt: lancamento.createdAt.toISOString(),
  };
}
