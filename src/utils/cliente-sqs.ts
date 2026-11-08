import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueNameExists,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Configuracao } from '../config';

export const URLS_DAS_FILAS = Symbol('QUEUE_URLS');

export interface UrlsDasFilas {
  apostas: string;
  dlqDeApostas: string;
  eventos: string;
}

/** Cliente SQS apontando para o LocalStack/MiniStack (ou AWS, se configurado). */
export function criarClienteSqs(config: Configuracao['sqs']): SQSClient {
  return new SQSClient({
    region: config.regiao,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.chaveDeAcesso, secretAccessKey: config.chaveSecreta },
  });
}

/**
 * Garante as filas FIFO: DLQ, fila de transações (redrive para a DLQ após
 * `maxTentativas` recebimentos) e a fila de eventos publicados pela outbox.
 */
export async function garantirFilas(sqs: SQSClient, config: Configuracao['sqs']): Promise<UrlsDasFilas> {
  const dlqDeApostas = await garantirFila(sqs, config.dlqDeApostas);
  const atributosDaDlq = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqDeApostas, AttributeNames: ['QueueArn'] }),
  );
  const apostas = await garantirFila(sqs, config.filaDeApostas, {
    VisibilityTimeout: String(config.visibilidadeSegundos),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: atributosDaDlq.Attributes?.QueueArn,
      maxReceiveCount: config.maxTentativas,
    }),
  });
  const eventos = await garantirFila(sqs, config.filaDeEventos);
  return { apostas, dlqDeApostas, eventos };
}

/** Cria a fila; se ela já existe (mesmo com outros atributos), só busca a URL. */
async function garantirFila(sqs: SQSClient, nome: string, atributos: Record<string, string> = {}): Promise<string> {
  try {
    const criada = await sqs.send(
      new CreateQueueCommand({ QueueName: nome, Attributes: { FifoQueue: 'true', ...atributos } }),
    );
    return criada.QueueUrl!;
  } catch (erro) {
    if (!(erro instanceof QueueNameExists) && (erro as Error).name !== 'QueueAlreadyExists') throw erro;
    return (await sqs.send(new GetQueueUrlCommand({ QueueName: nome }))).QueueUrl!;
  }
}
