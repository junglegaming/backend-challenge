import { describe, expect, test } from 'bun:test';
import { hashDaAposta } from '../../src/dto/aposta.dto';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { DomainError, InvariantError } from '../../src/domain/errors';
import { LiquidacaoDeAposta } from '../../src/domain/liquidacao-de-aposta';
import { FailureCode, WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const brl = (valor: string) => Money.from({ amount: valor, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');
const liquidacao = new LiquidacaoDeAposta({ esperaInicialMs: 1_000, esperaMaximaMs: 60_000, prazoMaximoMs: 10 * 60_000, maxTentativas: 30 });
let seq = 0;

function novaCarteira(saldo = '100.00') {
  return Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(saldo),
    openingTransactionId: 'open',
    openingEntryId: 'open-e',
    at: t0,
  }).wallet;
}

function novaTransacao(tipo: K, valor: string, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  const n = ++seq;
  return WagerTransaction.create({
    id: `tx-${n}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `provider-a:ext-${n}`,
    payloadHash: `hash-${n}`,
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game',
    kind: tipo,
    money: brl(valor),
    correlationId: 'c',
    createdAt: t0,
    ...extra,
  });
}

/** Processa uma transação contra a wallet (atalho para os testes). */
function liquidar(carteira: Wallet, transacao: WagerTransaction, referencia?: WagerTransaction, jaRevertida = false, agora = t0) {
  return liquidacao.liquidar({
    transacao,
    carteira,
    referencia,
    referenciaJaRevertida: jaRevertida,
    ledgerEntryId: `e-${++seq}`,
    agora,
  });
}

describe('BET', () => {
  test('debita e gera 1 lançamento DEBIT', () => {
    const carteira = novaCarteira('100.00');
    const aposta = novaTransacao(K.Bet, '25.00');
    const saida = liquidar(carteira, aposta);
    expect(saida.tipo).toBe('PROCESSADA');
    expect(saida.tipo === 'PROCESSADA' && saida.lancamento?.direction).toBe(LedgerDirection.Debit);
    expect(aposta.status).toBe(S.Processed);
    expect(aposta.balanceAfter?.amount).toBe('75.00');
    expect(carteira.balance.amount).toBe('75.00');
  });

  test('rejeita com INSUFFICIENT_FUNDS sem mexer no saldo', () => {
    const carteira = novaCarteira('10.00');
    const aposta = novaTransacao(K.Bet, '10.01');
    expect(liquidar(carteira, aposta)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.InsufficientFunds });
    expect(aposta.status).toBe(S.Rejected);
    expect(carteira.balance.amount).toBe('10.00');
    expect(carteira.version).toBe(1);
  });
});

describe('WIN / LOSS', () => {
  test('WIN credita', () => {
    const carteira = novaCarteira('0.00');
    const saida = liquidar(carteira, novaTransacao(K.Win, '50.00'));
    expect(saida.tipo === 'PROCESSADA' && saida.lancamento?.direction).toBe(LedgerDirection.Credit);
    expect(carteira.balance.amount).toBe('50.00');
  });

  test('LOSS é processada sem mover saldo nem gerar lançamento', () => {
    const carteira = novaCarteira('100.00');
    const perda = novaTransacao(K.Loss, '0.00');
    expect(liquidar(carteira, perda)).toEqual({ tipo: 'PROCESSADA' });
    expect(perda.status).toBe(S.Processed);
    expect(carteira.balance.amount).toBe('100.00');
    expect(carteira.version).toBe(1);
  });
});

describe('REFUND / ROLLBACK', () => {
  function apostaProcessada(carteira: Wallet, valor = '40.00') {
    const aposta = novaTransacao(K.Bet, valor);
    liquidar(carteira, aposta);
    return aposta;
  }

  test('exigem referenceExternalTransactionId', () => {
    expect(() => novaTransacao(K.Refund, '1.00')).toThrow(DomainError);
    expect(() => novaTransacao(K.Rollback, '1.00')).toThrow(DomainError);
  });

  test('REFUND de BET credita o valor', () => {
    const carteira = novaCarteira('100.00');
    const aposta = apostaProcessada(carteira);
    const reembolso = novaTransacao(K.Refund, '40.00', { referenceExternalTransactionId: aposta.externalTransactionId });
    expect(liquidar(carteira, reembolso, aposta).tipo).toBe('PROCESSADA');
    expect(reembolso.referenceTransactionId).toBe(aposta.id);
    expect(carteira.balance.amount).toBe('100.00');
  });

  test('REFUND só referencia BET', () => {
    const carteira = novaCarteira('100.00');
    const ganho = novaTransacao(K.Win, '10.00');
    liquidar(carteira, ganho);
    const reembolso = novaTransacao(K.Refund, '10.00', { referenceExternalTransactionId: ganho.externalTransactionId });
    expect(liquidar(carteira, reembolso, ganho)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.ReferenceKindNotAllowed });
  });

  test('não reverte duas vezes', () => {
    const carteira = novaCarteira('100.00');
    const aposta = apostaProcessada(carteira);
    const reembolso = novaTransacao(K.Refund, '40.00', { referenceExternalTransactionId: aposta.externalTransactionId });
    expect(liquidar(carteira, reembolso, aposta, true)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.ReferenceAlreadyReversed });
  });

  test('valor precisa ser igual ao da referência', () => {
    const carteira = novaCarteira('100.00');
    const aposta = apostaProcessada(carteira);
    const reembolso = novaTransacao(K.Refund, '39.99', { referenceExternalTransactionId: aposta.externalTransactionId });
    expect(liquidar(carteira, reembolso, aposta)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.ReversalAmountMismatch });
  });

  test('referência de outra rodada/jogador é rejeitada', () => {
    const carteira = novaCarteira('100.00');
    const aposta = apostaProcessada(carteira);
    const reembolso = novaTransacao(K.Refund, '40.00', { referenceExternalTransactionId: aposta.externalTransactionId, roundId: 'other' });
    expect(liquidar(carteira, reembolso, aposta)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.ReferenceMismatch });
  });

  test('ROLLBACK de BET credita; ROLLBACK de WIN debita', () => {
    const carteira = novaCarteira('100.00');
    const aposta = apostaProcessada(carteira, '30.00');
    const estornoDaAposta = novaTransacao(K.Rollback, '30.00', { referenceExternalTransactionId: aposta.externalTransactionId });
    const saida1 = liquidar(carteira, estornoDaAposta, aposta);
    expect(saida1.tipo === 'PROCESSADA' && saida1.lancamento?.direction).toBe(LedgerDirection.Credit);

    const ganho = novaTransacao(K.Win, '20.00');
    liquidar(carteira, ganho);
    const estornoDoGanho = novaTransacao(K.Rollback, '20.00', { referenceExternalTransactionId: ganho.externalTransactionId });
    const saida2 = liquidar(carteira, estornoDoGanho, ganho);
    expect(saida2.tipo === 'PROCESSADA' && saida2.lancamento?.direction).toBe(LedgerDirection.Debit);
    expect(carteira.balance.amount).toBe('100.00');
  });

  test('ROLLBACK que deixaria saldo negativo usa código distinto', () => {
    const carteira = novaCarteira('0.00');
    const ganho = novaTransacao(K.Win, '20.00');
    liquidar(carteira, ganho);
    carteira.debit({ entryId: 'x', transactionId: 'outra-aposta', money: brl('15.00'), at: t0 }); // jogador gastou o prêmio
    const estorno = novaTransacao(K.Rollback, '20.00', { referenceExternalTransactionId: ganho.externalTransactionId });
    expect(liquidar(carteira, estorno, ganho)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.ReversalInsufficientFunds });
    expect(carteira.balance.amount).toBe('5.00');
  });

  test('referência ausente → PENDING_REFERENCE e, esgotado o TTL, REFERENCE_NOT_FOUND', () => {
    const carteira = novaCarteira('100.00');
    const reembolso = novaTransacao(K.Refund, '10.00', { referenceExternalTransactionId: 'missing' });
    expect(liquidar(carteira, reembolso)).toEqual({ tipo: 'AGUARDANDO_REFERENCIA', primeiraVez: true });
    expect(reembolso.nextReferenceCheckAt?.getTime()).toBe(t0.getTime() + 1_000);

    expect(liquidar(carteira, reembolso, undefined, false, new Date(t0.getTime() + 2_000))).toEqual({
      tipo: 'AGUARDANDO_REFERENCIA',
      primeiraVez: false,
    });
    expect(reembolso.referenceAttempts).toBe(1);

    const depoisDoPrazo = new Date(t0.getTime() + 11 * 60_000);
    expect(liquidar(carteira, reembolso, undefined, false, depoisDoPrazo)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.ReferenceNotFound });
  });
});

describe('regras gerais', () => {
  test('conflito de moeda é rejeitado', () => {
    const carteira = novaCarteira('100.00');
    const aposta = novaTransacao(K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(liquidar(carteira, aposta)).toEqual({ tipo: 'REJEITADA', codigo: FailureCode.CurrencyMismatch });
  });

  test('jogador diferente do dono da wallet é rejeitado', () => {
    const carteira = novaCarteira('100.00');
    expect(liquidar(carteira, novaTransacao(K.Bet, '1.00', { playerId: 'p2' }))).toEqual({
      tipo: 'REJEITADA',
      codigo: FailureCode.WalletPlayerMismatch,
    });
  });

  test('estados terminais não transicionam', () => {
    const carteira = novaCarteira('100.00');
    const aposta = novaTransacao(K.Bet, '1.00');
    liquidar(carteira, aposta);
    expect(() => aposta.reject(FailureCode.InsufficientFunds, carteira.balance)).toThrow(InvariantError);
    expect(() => aposta.markProcessed(undefined, t0, carteira.balance)).toThrow(InvariantError);
  });
});

describe('idempotência (payloadHash)', () => {
  const dados = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET' as const,
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('mesmo payload → mesmo hash, independente da ordem das chaves e da escala do amount', () => {
    const reordenado = { ...dados, money: { currency: 'BRL', amount: '25' } };
    expect(hashDaAposta(reordenado)).toBe(hashDaAposta(dados));
  });

  test('payload divergente → hash diferente → conflito, não replay', () => {
    const outro = { ...dados, money: { amount: '26.00', currency: 'BRL' } };
    const hash = hashDaAposta(dados);
    const gravada = novaTransacao(K.Bet, '25.00', { payloadHash: hash });
    expect(gravada.matchesPayload(hashDaAposta(dados))).toBe(true);
    expect(gravada.matchesPayload(hashDaAposta(outro))).toBe(false);
  });
});
