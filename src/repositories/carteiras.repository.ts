import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ErroDeConcorrencia } from '../utils/erros';
import { CarteiraEntity } from '../database/entidades';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';

/** Tabela wallets. Converte as linhas do banco em objetos `Wallet` e vice-versa. */
export class CarteirasRepository {
  constructor(private readonly em: EntityManager) {}

  async buscarPorId(id: string): Promise<Wallet | undefined> {
    const linha = await this.em.findOne(CarteiraEntity, { id }, { refresh: true });
    return linha ? paraCarteira(linha) : undefined;
  }

  /** SELECT ... FOR UPDATE: trava só esta wallet até o fim da transação. */
  async travar(id: string): Promise<Wallet | undefined> {
    const linha = await this.em.findOne(
      CarteiraEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return linha ? paraCarteira(linha) : undefined;
  }

  async inserir(carteira: Wallet): Promise<void> {
    await this.em.insert(CarteiraEntity, {
      id: carteira.id,
      playerId: carteira.playerId,
      currency: carteira.currency,
      balance: carteira.balance.amount,
      version: carteira.version,
      createdAt: carteira.createdAt,
      updatedAt: carteira.updatedAt,
    });
  }

  /** Só atualiza se a versão no banco ainda for a anterior (proteção extra além do lock). */
  async atualizarSaldo(carteira: Wallet): Promise<void> {
    const atualizadas = await this.em.nativeUpdate(
      CarteiraEntity,
      { id: carteira.id, version: carteira.version - 1 },
      { balance: carteira.balance.amount, version: carteira.version, updatedAt: carteira.updatedAt },
    );
    if (atualizadas !== 1) throw new ErroDeConcorrencia('optimistic_lock');
  }
}

function paraCarteira(linha: CarteiraEntity): Wallet {
  return Wallet.rehydrate({
    id: linha.id,
    playerId: linha.playerId,
    currency: linha.currency,
    balance: Money.from({ amount: linha.balance, currency: linha.currency }),
    version: linha.version,
    createdAt: linha.createdAt,
    updatedAt: linha.updatedAt,
  });
}
