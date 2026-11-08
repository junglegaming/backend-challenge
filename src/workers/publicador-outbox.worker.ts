import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Logger } from '../utils/logger';
import { MetricasService } from '../utils/metricas.service';
import { URLS_DAS_FILAS, type UrlsDasFilas } from '../utils/cliente-sqs';
import { LoopPeriodico } from '../utils/utilitarios';
import { CONFIGURACAO, type Configuracao } from '../config';
import { OutboxMessage } from '../domain/outbox-message';
import { UnidadeDeTrabalho } from '../repositories/unidade-de-trabalho';

/**
 * Publica no SQS os eventos gravados na outbox.
 *
 * Pode rodar em várias instâncias: cada uma trava um lote diferente
 * (FOR UPDATE SKIP LOCKED). O evento só é marcado como publicado no commit,
 * DEPOIS do envio. Então:
 *  - se o processo morrer antes de enviar, outra instância envia;
 *  - se morrer depois de enviar e antes do commit, o evento é enviado de novo.
 *    Sem problema: o eventId é o mesmo e quem consome ignora a repetição.
 */
@Injectable()
export class PublicadorOutboxWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: LoopPeriodico;

  constructor(
    private readonly unidadeDeTrabalho: UnidadeDeTrabalho,
    private readonly sqs: SQSClient,
    @Inject(URLS_DAS_FILAS) private readonly filas: UrlsDasFilas,
    private readonly metricas: MetricasService,
    private readonly logger: Logger,
    @Inject(CONFIGURACAO) private readonly config: Configuracao,
  ) {
    this.loop = new LoopPeriodico(
      config.intervaloOutboxMs,
      () => this.publicarPendentes(),
      (erro) => logger.warn({ err: erro.message }, 'falha no relay da outbox'),
    );
  }

  onApplicationBootstrap() {
    if (this.config.workers.has('outbox')) this.loop.iniciar();
  }

  async beforeApplicationShutdown() {
    await this.loop.parar();
  }

  /** Uma rodada: trava até `limite` eventos pendentes, publica no SQS e marca como publicados. */
  async publicarPendentes(limite = 50): Promise<void> {
    await this.unidadeDeTrabalho.executar(async (repos) => {
      const linhas = await repos.outbox.travarPendentes(limite);
      if (linhas.length > 0 && this.config.falhaSimulada === 'crash-before-outbox-publish') {
        this.logger.error({}, 'FAULT_INJECTION: encerrando antes de publicar a outbox');
        process.exit(137); // simula o processo morrendo (só em testes)
      }

      for (const linha of linhas) {
        const mensagem = OutboxMessage.rehydrate({
          id: linha.id,
          aggregateId: linha.aggregateId,
          eventType: linha.eventType,
          payload: linha.payload,
          occurredAt: linha.occurredAt,
          attempts: linha.attempts,
          nextAttemptAt: linha.nextAttemptAt,
        });
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.filas.eventos,
              MessageBody: JSON.stringify(linha.payload),
              MessageGroupId: linha.aggregateId,
              MessageDeduplicationId: linha.id,
            }),
          );
          mensagem.markPublished(new Date());
        } catch (erro) {
          mensagem.scheduleRetry(new Date());
          this.logger.warn({ eventId: linha.id, err: (erro as Error).message }, 'falha ao publicar evento');
        }
        // `linha` é gerenciada pelo MikroORM: o UPDATE acontece sozinho no commit
        linha.attempts = mensagem.attempts;
        linha.nextAttemptAt = mensagem.nextAttemptAt ?? linha.nextAttemptAt;
        linha.publishedAt = mensagem.publishedAt ?? null;
        if (mensagem.isPending()) break; // SQS com problema: o resto fica para depois
      }
    });

    this.metricas.atrasoDaOutbox.set(await this.unidadeDeTrabalho.executar((repos) => repos.outbox.atrasoEmSegundos()));
  }
}
