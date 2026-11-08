import { AsyncLocalStorage } from 'node:async_hooks';
import { LoggerService } from '@nestjs/common';
import pino from 'pino';

/** correlationId/messageId da requisição ou mensagem atual, anexados a todo log. */
export const contextoDoLog = new AsyncLocalStorage<{ correlationId?: string; messageId?: string }>();

export function correlationIdAtual(): string {
  return contextoDoLog.getStore()?.correlationId ?? crypto.randomUUID();
}

type Campos = Record<string, unknown>;

/**
 * Logger JSON (pino). Uso na aplicação: `logger.info({ walletId }, 'mensagem')`.
 * Também é o logger interno do Nest, que chama `log('mensagem', contexto)`.
 */
export class Logger implements LoggerService {
  private readonly pino: pino.Logger;

  constructor(nivel: string) {
    this.pino = pino({
      level: nivel,
      base: { service: 'wagering' },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => ({ ...contextoDoLog.getStore() }),
      // nunca logar valores ou payloads financeiros completos
      redact: { paths: ['money', 'balance', 'payload'], remove: true },
    });
  }

  info(campos: Campos | string, mensagem?: string) {
    this.escrever('info', campos, mensagem);
  }

  warn(campos: Campos | string, mensagem?: string) {
    this.escrever('warn', campos, mensagem);
  }

  error(campos: Campos | string, mensagem?: string) {
    this.escrever('error', campos, mensagem);
  }

  log(mensagem: string, contexto?: string) {
    this.pino.info({ context: contexto }, mensagem);
  }

  private escrever(nivel: 'info' | 'warn' | 'error', campos: Campos | string, mensagem?: string) {
    if (typeof campos === 'string') this.pino[nivel]({ context: mensagem }, campos);
    else this.pino[nivel](campos, mensagem);
  }
}
