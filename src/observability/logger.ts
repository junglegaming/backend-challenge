import pino from 'pino';
import { config } from '../config';

/**
 * Logs JSON estruturados. Campos de correlação (correlationId, messageId, transactionId, walletId,
 * providerId) vão como propriedades. Valores monetários e payloads completos nunca são logados.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'wagering-processor', instanceId: config.instanceId },
  timestamp: pino.stdTimeFunctions.isoTime,
});
