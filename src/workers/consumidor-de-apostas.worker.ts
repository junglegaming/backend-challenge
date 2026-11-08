import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { ErroHttp } from '../utils/erros';
import { Logger, contextoDoLog } from '../utils/logger';
import { MetricasService } from '../utils/metricas.service';
import { URLS_DAS_FILAS, type UrlsDasFilas } from '../utils/cliente-sqs';
import { validar } from '../utils/validacao';
import { CONFIGURACAO, type Configuracao } from '../config';
import { schemaDaAposta } from '../dto/aposta.dto';
import { ApostasService } from '../services/apostas.service';

const schemaDaMensagem = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: schemaDaAposta.extend({ idempotencyKey: z.string().min(1).max(256) }),
});

/**
 * Lê a fila wager-transactions.fifo e processa cada aposta com o mesmo
 * ApostasService do HTTP.
 *
 * O que acontece com cada mensagem:
 *  - processou (inclusive rejeição de negócio) → apaga da fila (ack)
 *  - mensagem inválida                         → vai direto para a DLQ
 *  - outro erro (banco fora, lock demorado)    → volta para a fila com espera crescente;
 *                                                depois de N tentativas → FAILED + DLQ
 * O ack só acontece depois do commit. Se o processo morrer antes, a mensagem
 * volta e o inbox percebe que ela já foi processada.
 */
@Injectable()
export class ConsumidorDeApostasWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private rodando = false;
  private loop?: Promise<void>;
  private readonly cancelamento = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    @Inject(URLS_DAS_FILAS) private readonly filas: UrlsDasFilas,
    private readonly apostasService: ApostasService,
    private readonly metricas: MetricasService,
    private readonly logger: Logger,
    @Inject(CONFIGURACAO) private readonly config: Configuracao,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.workers.has('consumer')) return;
    this.rodando = true;
    this.loop = this.lerFila();
  }

  /** SIGTERM: para de buscar, termina o que está processando e devolve o resto para a fila. */
  async beforeApplicationShutdown() {
    this.rodando = false;
    this.cancelamento.abort();
    await this.loop;
  }

  private async lerFila(): Promise<void> {
    while (this.rodando) {
      let mensagens: Message[] = [];
      try {
        const resposta = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.filas.apostas,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
            AttributeNames: ['All'],
          }),
          { abortSignal: this.cancelamento.signal },
        );
        mensagens = resposta.Messages ?? [];
      } catch (erro) {
        if (!this.rodando) break;
        this.logger.warn({ err: (erro as Error).message }, 'falha ao ler a fila');
        await Bun.sleep(1_000);
      }

      // FIFO: mensagens da mesma wallet (mesmo grupo) em ordem; grupos diferentes em paralelo
      const grupos = Map.groupBy(mensagens, (m) => m.Attributes?.MessageGroupId ?? m.MessageId);
      await Promise.all(
        [...grupos.values()].map(async (grupo) => {
          for (const mensagem of grupo) {
            if (this.rodando) await this.processarMensagem(mensagem);
            else await this.mudarVisibilidade(mensagem, 0); // desligando: devolve para outra instância
          }
        }),
      );
    }
  }

  private async processarMensagem(mensagem: Message): Promise<void> {
    let corpo: z.infer<typeof schemaDaMensagem>;
    try {
      corpo = validar(schemaDaMensagem, JSON.parse(mensagem.Body ?? ''));
    } catch {
      return this.enviarParaDlq(mensagem, 'INVALID_MESSAGE');
    }
    const { messageId, data: dados } = corpo;
    const tentativa = Number(mensagem.Attributes?.ApproximateReceiveCount ?? '1');

    await contextoDoLog.run({ correlationId: messageId, messageId }, async () => {
      try {
        await this.apostasService.processarAposta(dados, { origem: 'SQS', correlationId: messageId, messageId });
        if (this.config.falhaSimulada === 'crash-after-commit-before-ack') {
          process.exit(137); // simula o processo morrendo depois do commit (só em testes)
        }
        await this.apagarMensagem(mensagem);
      } catch (erro) {
        if (erro instanceof ErroHttp && erro.status === 400) {
          return this.enviarParaDlq(mensagem, 'INVALID_MESSAGE');
        }
        if (tentativa >= this.config.sqs.maxTentativas) {
          await this.apostasService
            .registrarFalha(dados, messageId)
            .catch((erro) => this.logger.error({ err: (erro as Error).message }, 'não foi possível gravar FAILED'));
          return this.enviarParaDlq(mensagem, 'MAX_ATTEMPTS');
        }
        // volta para a fila depois de 2s, 4s, 8s... (no máximo 5 min)
        this.metricas.novasTentativas.inc({ operation: 'sqs_message' });
        const motivo = (erro as Error).message;
        this.logger.warn({ err: motivo, attempt: tentativa }, 'falha temporária, a mensagem volta para a fila');
        await this.mudarVisibilidade(mensagem, Math.min(2 ** tentativa, 300));
      }
    });
  }

  /** Ack: apaga a mensagem. Se falhar, ela volta e o inbox reconhece a duplicata. */
  private async apagarMensagem(mensagem: Message): Promise<void> {
    await this.sqs
      .send(new DeleteMessageCommand({ QueueUrl: this.filas.apostas, ReceiptHandle: mensagem.ReceiptHandle }))
      .catch((erro) => this.logger.warn({ err: (erro as Error).message }, 'falha ao apagar mensagem'));
  }

  /**
   * Esconde a mensagem por `segundos` (0 = devolve para a fila na hora).
   * Erro aqui é ignorado: quando o visibility timeout vence, o SQS devolve sozinho.
   */
  private async mudarVisibilidade(mensagem: Message, segundos: number): Promise<void> {
    const comando = new ChangeMessageVisibilityCommand({
      QueueUrl: this.filas.apostas,
      ReceiptHandle: mensagem.ReceiptHandle,
      VisibilityTimeout: segundos,
    });
    await this.sqs.send(comando).catch(() => undefined);
  }

  private async enviarParaDlq(mensagem: Message, motivo: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.filas.dlqDeApostas,
        MessageBody: mensagem.Body ?? '',
        MessageGroupId: mensagem.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: mensagem.MessageId,
        MessageAttributes: { failureReason: { DataType: 'String', StringValue: motivo } },
      }),
    );
    await this.apagarMensagem(mensagem);
    this.metricas.mensagensNaDlq.inc({ reason: motivo });
    this.logger.error({ reason: motivo, sqsMessageId: mensagem.MessageId }, 'mensagem enviada para a DLQ');
  }
}
