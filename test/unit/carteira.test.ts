import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { DomainError, InvariantError } from '../../src/domain/errors';
import { Wallet } from '../../src/domain/wallet';

const brl = (valor: string) => Money.from({ amount: valor, currency: 'BRL' });
const agora = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const id = () => `id-${++seq}`;

function abrirCarteira(inicial: string) {
  return Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(inicial),
    openingTransactionId: 'tx-open',
    openingEntryId: 'e-open',
    at: agora,
  });
}

describe('Wallet', () => {
  test('abre na versão 1 com lançamento de abertura quando saldo > 0', () => {
    const { wallet: carteira, openingEntry: lancamentoDeAbertura } = abrirCarteira('100.00');
    expect(carteira.version).toBe(1);
    expect(carteira.balance.amount).toBe('100.00');
    expect(lancamentoDeAbertura?.direction).toBe(LedgerDirection.Credit);
    expect(lancamentoDeAbertura?.balanceBefore.amount).toBe('0.00');
    expect(lancamentoDeAbertura?.balanceAfter.amount).toBe('100.00');
    expect(lancamentoDeAbertura?.walletVersion).toBe(1);
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet: carteira, openingEntry: lancamentoDeAbertura } = abrirCarteira('0.00');
    expect(carteira.version).toBe(1);
    expect(lancamentoDeAbertura).toBeUndefined();
  });

  test('débito e crédito geram lançamento consistente e incrementam versão', () => {
    const { wallet: carteira } = abrirCarteira('100.00');
    const debito = carteira.debit({ entryId: id(), transactionId: 't1', money: brl('30.00'), at: agora });
    expect(debito.balanceBefore.amount).toBe('100.00');
    expect(debito.balanceAfter.amount).toBe('70.00');
    expect(debito.walletVersion).toBe(2);
    const credito = carteira.credit({ entryId: id(), transactionId: 't2', money: brl('5.50'), at: agora });
    expect(credito.balanceAfter.amount).toBe('75.50');
    expect(carteira.balance.amount).toBe('75.50');
    expect(carteira.version).toBe(3);
  });

  test('saldo nunca fica negativo e falha não altera estado', () => {
    const { wallet: carteira } = abrirCarteira('10.00');
    expect(() => carteira.debit({ entryId: id(), transactionId: 't', money: brl('10.01'), at: agora })).toThrow(
      DomainError,
    );
    expect(carteira.balance.amount).toBe('10.00');
    expect(carteira.version).toBe(1);
    // debitar exatamente o saldo é permitido
    carteira.debit({ entryId: id(), transactionId: 't', money: brl('10.00'), at: agora });
    expect(carteira.balance.amount).toBe('0.00');
  });

  test('moeda da operação precisa ser a moeda da wallet', () => {
    const { wallet: carteira } = abrirCarteira('10.00');
    const dolar = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => carteira.credit({ entryId: id(), transactionId: 't', money: dolar, at: agora })).toThrow(DomainError);
    expect(() => carteira.debit({ entryId: id(), transactionId: 't', money: dolar, at: agora })).toThrow(DomainError);
  });

  test('saldo == saldo reconstruído pelo ledger', () => {
    const { wallet: carteira, openingEntry: lancamentoDeAbertura } = abrirCarteira('50.00');
    const lancamentos = [lancamentoDeAbertura!];
    lancamentos.push(carteira.debit({ entryId: id(), transactionId: 'a', money: brl('20.00'), at: agora }));
    lancamentos.push(carteira.credit({ entryId: id(), transactionId: 'b', money: brl('7.25'), at: agora }));
    const peloExtrato = lancamentos.reduce(
      (soma, erro) => (erro.direction === LedgerDirection.Credit ? soma.add(erro.money) : soma.subtract(erro.money)),
      Money.zero('BRL'),
    );
    expect(peloExtrato.equals(carteira.balance)).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  test('create valida a aritmética', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('50.00'),
        balanceAfter: brl('45.00'),
        walletVersion: 2,
        createdAt: agora,
      }),
    ).toThrow(InvariantError);
  });

  test('é estruturalmente imutável', () => {
    const { openingEntry: lancamentoDeAbertura } = abrirCarteira('10.00');
    expect(Object.isFrozen(lancamentoDeAbertura)).toBe(true);
    expect(lancamentoDeAbertura!.isBalanced()).toBe(true);
  });
});
