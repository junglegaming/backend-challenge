import type { EntityManager } from '@mikro-orm/postgresql';
import { LancamentoEntity } from '../database/entidades';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { Money } from '../domain/money';

/** Ledger (tabela wallet_ledger_entries): só insere e lê, nunca altera. */
export class LancamentosRepository {
  constructor(private readonly em: EntityManager) {}

  async adicionar(lancamento: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LancamentoEntity, {
      id: lancamento.id,
      walletId: lancamento.walletId,
      transactionId: lancamento.transactionId,
      direction: lancamento.direction,
      amount: lancamento.money.amount,
      currency: lancamento.money.currency,
      balanceBefore: lancamento.balanceBefore.amount,
      balanceAfter: lancamento.balanceAfter.amount,
      walletVersion: lancamento.walletVersion,
      createdAt: lancamento.createdAt,
    });
  }

  /** Lançamentos depois de `depoisDaVersao`, em ordem (a versão é única por wallet). */
  async pagina(walletId: string, depoisDaVersao: number, limite: number): Promise<WalletLedgerEntry[]> {
    const linhas = await this.em.find(
      LancamentoEntity,
      { walletId, walletVersion: { $gt: depoisDaVersao } },
      { orderBy: { walletVersion: 'asc' }, limit: limite },
    );
    return linhas.map(paraLancamento);
  }

  /** Saldo calculado pelo ledger: soma dos créditos - soma dos débitos. */
  async saldoPeloExtrato(walletId: string, moeda: string): Promise<{ saldo: Money; quantidade: number }> {
    const [linha] = await this.em.execute(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as net,
              count(*)::int as entries
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    );
    const liquido: string = linha?.net ?? '0.00';
    // em caso de inconsistência a soma pode dar negativa
    const saldo = liquido.startsWith('-')
      ? Money.from({ amount: liquido.slice(1), currency: moeda }).negate()
      : Money.from({ amount: liquido, currency: moeda });
    return { saldo, quantidade: linha?.entries ?? 0 };
  }
}

function paraLancamento(linha: LancamentoEntity): WalletLedgerEntry {
  const dinheiro = (valor: string) => Money.from({ amount: valor, currency: linha.currency });
  return WalletLedgerEntry.rehydrate({
    id: linha.id,
    walletId: linha.walletId,
    transactionId: linha.transactionId,
    direction: linha.direction as LedgerDirection,
    money: dinheiro(linha.amount),
    balanceBefore: dinheiro(linha.balanceBefore),
    balanceAfter: dinheiro(linha.balanceAfter),
    walletVersion: linha.walletVersion,
    createdAt: linha.createdAt,
  });
}
