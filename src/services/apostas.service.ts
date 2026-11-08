import { Inject, Injectable } from '@nestjs/common';
import { ErroDeConcorrencia, ErroHttp } from '../utils/erros';
import { Logger } from '../utils/logger';
import { MetricasService } from '../utils/metricas.service';
import { novoId, repetirSeHouverConflito } from '../utils/utilitarios';
import { ehUuid } from '../utils/validacao';
import { CONFIGURACAO, type Configuracao } from '../config';
import { DomainError } from '../domain/errors';
import {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { InboxMessage } from '../domain/inbox-message';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { LiquidacaoDeAposta, type ResultadoDaLiquidacao } from '../domain/liquidacao-de-aposta';
import { FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { type ApostaDto, hashDaAposta } from '../dto/aposta.dto';
import { type Repositorios, UnidadeDeTrabalho } from '../repositories/unidade-de-trabalho';

export interface ContextoDaAposta {
  origem: 'HTTP' | 'SQS';
  correlationId: string;
  messageId?: string; // só vem da fila: usado no inbox para detectar duplicatas
}

export type ResultadoDaAposta =
  | { tipo: 'RESULTADO'; transacao: WagerTransaction; saldo: Money; repetida: boolean }
  | { tipo: 'CONFLITO_DE_IDEMPOTENCIA'; transactionId: string }
  | { tipo: 'CARTEIRA_NAO_ENCONTRADA' }
  | { tipo: 'MENSAGEM_DUPLICADA' };

@Injectable()
export class ApostasService {
  private readonly liquidacao: LiquidacaoDeAposta;

  constructor(
    private readonly unidadeDeTrabalho: UnidadeDeTrabalho,
    private readonly metricas: MetricasService,
    private readonly logger: Logger,
    @Inject(CONFIGURACAO) private readonly config: Configuracao,
  ) {
    this.liquidacao = new LiquidacaoDeAposta(config.referenciaPendente);
  }

  /** Processa uma aposta vinda do HTTP ou da fila (mesmo código para os dois). */
  async processarAposta(dto: ApostaDto, contexto: ContextoDaAposta): Promise<ResultadoDaAposta> {
    const inicio = performance.now();
    const hash = hashDaAposta(dto);
    this.novaTransacao(dto, hash, contexto.correlationId); // valida o tipo antes de abrir transação no banco

    // se perder uma corrida no banco, tenta de novo: a nova tentativa vê o resultado de quem ganhou
    const resultado = await repetirSeHouverConflito(
      () => this.unidadeDeTrabalho.executar((repos) => this.processarNaTransacao(repos, dto, hash, contexto)),
      (erro) => this.contarNovaTentativa('submit_wager', erro),
    );

    this.metricas.tempoDeProcessamento.observe({ source: contexto.origem }, (performance.now() - inicio) / 1000);
    if (resultado.tipo === 'RESULTADO' && !resultado.repetida) {
      this.metricas.transacoes.inc({ kind: dto.kind, status: resultado.transacao.status, source: contexto.origem });
    }
    this.logger.info(
      {
        walletId: dto.walletId,
        providerId: dto.providerId,
        transactionId: resultado.tipo === 'RESULTADO' ? resultado.transacao.id : undefined,
        resultado: resultado.tipo === 'RESULTADO' ? resultado.transacao.status : resultado.tipo,
      },
      'aposta processada',
    );
    return resultado;
  }

  /**
   * Mensagem da fila que esgotou as tentativas: grava a transação como FAILED
   * (para auditoria) antes de ir para a DLQ. Não mexe em saldo.
   */
  async registrarFalha(dto: ApostaDto, correlationId: string): Promise<void> {
    await this.unidadeDeTrabalho.executar(async (repos) => {
      const jaExiste =
        (await repos.transacoes.buscarPorChaveDeIdempotencia(dto.idempotencyKey)) ||
        (await repos.transacoes.buscarPorIdExterno(dto.providerId, dto.externalTransactionId));
      if (jaExiste || !(await repos.carteiras.buscarPorId(dto.walletId))) return;

      const transacao = this.novaTransacao(dto, hashDaAposta(dto), correlationId);
      transacao.fail(FailureCode.ProcessingFailed);
      await repos.transacoes.inserir(transacao);
      this.metricas.transacoes.inc({ kind: dto.kind, status: transacao.status, source: 'SQS' });
    });
  }

  /**
   * Tenta de novo as transações que estavam esperando a referência.
   * Trava a wallet antes (mesma ordem do submit, então não há deadlock) e só
   * continua se a transação ainda estiver pendente — assim, duas instâncias
   * pegando a mesma linha não processam duas vezes.
   */
  async processarReferenciasPendentes(limite = 50): Promise<void> {
    const vencidas = await this.unidadeDeTrabalho.executar((repos) =>
      repos.transacoes.buscarReferenciasVencidas(new Date(), limite),
    );
    for (const { id, walletId } of vencidas) {
      try {
        const transacao = await repetirSeHouverConflito(
          () =>
            this.unidadeDeTrabalho.executar(async (repos) => {
              const carteira = await repos.carteiras.travar(walletId);
              const transacao = await repos.transacoes.buscarPorId(id);
              if (!carteira || transacao?.status !== WagerTransactionStatus.PendingReference) return undefined;

              const resultado = await this.aplicarRegras(repos, transacao, carteira);
              await repos.transacoes.atualizarStatus(transacao);
              await this.gravarEfeitos(repos, transacao, carteira, resultado, transacao.id);
              return transacao;
            }),
          (erro) => this.contarNovaTentativa('pending_reference', erro),
        );
        if (transacao && transacao.status !== WagerTransactionStatus.PendingReference) {
          this.metricas.transacoes.inc({ kind: transacao.kind, status: transacao.status, source: 'WORKER' });
          this.logger.info(
            { transactionId: transacao.id, walletId, status: transacao.status },
            'referência pendente resolvida',
          );
        }
      } catch (erro) {
        // continua vencida: será tentada de novo na próxima rodada
        const motivo = (erro as Error).message;
        this.logger.warn({ transactionId: id, err: motivo }, 'falha ao reprocessar referência pendente');
      }
    }
  }

  /** Busca pelo id interno; 404 se não existir. */
  async buscarPorId(transactionId: string): Promise<WagerTransaction> {
    const transacao = ehUuid(transactionId)
      ? await this.unidadeDeTrabalho.executar((repos) => repos.transacoes.buscarPorId(transactionId))
      : undefined;
    if (!transacao) throw new ErroHttp(404, 'NOT_FOUND', 'transação não encontrada');
    return transacao;
  }

  /** Busca pelo id do provedor; 404 se não existir. */
  async buscarPorIdExterno(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transacao = await this.unidadeDeTrabalho.executar((repos) =>
      repos.transacoes.buscarPorIdExterno(providerId, externalTransactionId),
    );
    if (!transacao) throw new ErroHttp(404, 'NOT_FOUND', 'transação não encontrada');
    return transacao;
  }

  // ------------------------------------------------------------------

  /** Tudo aqui dentro roda numa única transação SQL. */
  private async processarNaTransacao(
    repos: Repositorios,
    dto: ApostaDto,
    hash: string,
    contexto: ContextoDaAposta,
  ): Promise<ResultadoDaAposta> {
    // 1. Fila: registra a mensagem no inbox. Se já existia, é reentrega.
    if (contexto.messageId) {
      const agora = new Date();
      const mensagem = InboxMessage.receive({
        messageId: contexto.messageId,
        consumerName: this.config.sqs.nomeDoConsumidor,
        payloadHash: hash,
        receivedAt: agora,
      });
      mensagem.markProcessed(agora); // vai junto no mesmo commit do efeito
      if (!(await repos.inbox.tentarInserir(mensagem))) {
        this.metricas.duplicatas.inc({ kind: 'inbox_duplicate' });
        const anterior = await repos.transacoes.buscarPorChaveDeIdempotencia(dto.idempotencyKey);
        return anterior ? this.repetirResultado(repos, anterior, hash) : { tipo: 'MENSAGEM_DUPLICADA' };
      }
    }

    // 2. Já vimos essa idempotency key? Devolve o resultado original.
    const existente = await repos.transacoes.buscarPorChaveDeIdempotencia(dto.idempotencyKey);
    if (existente) return this.repetirResultado(repos, existente, hash);

    // 3. Trava a wallet (SELECT ... FOR UPDATE): operações da MESMA wallet esperam na fila.
    const carteira = await repos.carteiras.travar(dto.walletId);
    if (!carteira) return { tipo: 'CARTEIRA_NAO_ENCONTRADA' };

    // 4. Confere de novo depois do lock: alguém pode ter gravado a mesma key enquanto esperávamos.
    const concorrente = await repos.transacoes.buscarPorChaveDeIdempotencia(dto.idempotencyKey);
    if (concorrente) return this.repetirResultado(repos, concorrente, hash);
    const mesmoIdExterno = await repos.transacoes.buscarPorIdExterno(dto.providerId, dto.externalTransactionId);
    if (mesmoIdExterno) {
      this.metricas.conflitosDeIdempotencia.inc();
      return { tipo: 'CONFLITO_DE_IDEMPOTENCIA', transactionId: mesmoIdExterno.id };
    }

    // 5. Aplica as regras e grava tudo.
    const transacao = this.novaTransacao(dto, hash, contexto.correlationId);
    const resultado = await this.aplicarRegras(repos, transacao, carteira);
    await repos.transacoes.inserir(transacao);
    await this.gravarEfeitos(repos, transacao, carteira, resultado, contexto.messageId);
    return { tipo: 'RESULTADO', transacao, saldo: carteira.balance, repetida: false };
  }

  /** Mesma key: se o payload é igual devolve o resultado original; se é diferente, é conflito. */
  private async repetirResultado(
    repos: Repositorios,
    transacao: WagerTransaction,
    hash: string,
  ): Promise<ResultadoDaAposta> {
    if (!transacao.matchesPayload(hash)) {
      this.metricas.conflitosDeIdempotencia.inc();
      return { tipo: 'CONFLITO_DE_IDEMPOTENCIA', transactionId: transacao.id };
    }
    this.metricas.duplicatas.inc({ kind: 'idempotent_replay' });
    // resultado final: saldo daquele momento; ainda pendente: saldo atual
    const carteiraAtual = transacao.balanceAfter ? undefined : await repos.carteiras.buscarPorId(transacao.walletId);
    const saldo = transacao.balanceAfter ?? carteiraAtual?.balance ?? Money.zero(transacao.money.currency);
    return { tipo: 'RESULTADO', transacao, saldo, repetida: true };
  }

  /**
   * Busca a referência (se houver) e aplica as regras de negócio: muda o status
   * da transação e, se for o caso, o saldo da carteira. Ainda não grava nada.
   * A wallet já deve estar travada.
   */
  private async aplicarRegras(
    repos: Repositorios,
    transacao: WagerTransaction,
    carteira: Wallet,
  ): Promise<ResultadoDaLiquidacao> {
    const referencia = transacao.referenceExternalTransactionId
      ? await repos.transacoes.buscarPorIdExterno(transacao.providerId, transacao.referenceExternalTransactionId)
      : undefined;
    const referenciaJaRevertida =
      referencia && transacao.requiresReference() ? await repos.transacoes.jaFoiRevertida(referencia.id) : false;

    return this.liquidacao.liquidar({
      transacao,
      carteira,
      referencia,
      referenciaJaRevertida,
      ledgerEntryId: novoId(),
      agora: new Date(),
    });
  }

  /**
   * Grava o que as regras decidiram: saldo e ledger (se mudou) e os eventos na
   * outbox. A transação já deve ter sido gravada (o ledger aponta para ela).
   */
  private async gravarEfeitos(
    repos: Repositorios,
    transacao: WagerTransaction,
    carteira: Wallet,
    resultado: ResultadoDaLiquidacao,
    causationId?: string,
  ): Promise<void> {
    const agora = new Date();
    if (resultado.tipo === 'PROCESSADA' && resultado.lancamento) {
      await repos.carteiras.atualizarSaldo(carteira);
      await repos.lancamentos.adicionar(resultado.lancamento);
    }

    const { correlationId } = transacao;
    const contexto = () => ({ eventId: novoId(), correlationId, causationId, occurredAt: agora });
    const eventos: IntegrationEvent<unknown>[] = [];
    if (resultado.tipo === 'PROCESSADA') {
      eventos.push(WagerTransactionProcessed.from(transacao, contexto()));
      if (resultado.lancamento) eventos.push(WalletBalanceChanged.from(carteira, resultado.lancamento, contexto()));
    } else if (resultado.tipo === 'REJEITADA') {
      eventos.push(WagerTransactionRejected.from(transacao, contexto()));
    } else if (resultado.primeiraVez) {
      eventos.push(WagerTransactionPendingReference.from(transacao, contexto())); // só avisa na primeira vez
    }
    if (eventos.length > 0) await repos.outbox.adicionar(eventos.map((evento) => OutboxMessage.enqueue(evento)));
  }

  /**
   * Monta a transação a partir do DTO. As regras de cada tipo (ex.: REFUND sem
   * referência) viram erro 400, porque são erro de quem enviou.
   */
  private novaTransacao(dto: ApostaDto, hashDoConteudo: string, correlationId: string): WagerTransaction {
    try {
      return WagerTransaction.create({
        ...dto,
        id: novoId(),
        payloadHash: hashDoConteudo,
        kind: dto.kind as WagerTransactionKind,
        money: Money.from(dto.money),
        correlationId,
        createdAt: new Date(),
      });
    } catch (erro) {
      if (erro instanceof DomainError) throw new ErroHttp(400, 'VALIDATION_ERROR', erro.message);
      throw erro;
    }
  }

  /** Métricas de cada vez que uma corrida no banco obriga a repetir a operação. */
  private contarNovaTentativa(operacao: string, erro: ErroDeConcorrencia) {
    this.metricas.conflitosDeConcorrencia.inc({ reason: erro.motivo });
    this.metricas.novasTentativas.inc({ operation: operacao });
  }
}
