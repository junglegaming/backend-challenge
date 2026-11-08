import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request } from 'express';
import { AppModule } from './app.module';
import { FiltroDeErros } from './utils/filtro-de-erros.filter';
import { Logger, contextoDoLog } from './utils/logger';
import { type Configuracao, carregarConfiguracao } from './config';

export async function iniciarAplicacao(config: Configuracao = carregarConfiguracao()) {
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.useGlobalFilters(new FiltroDeErros(logger));

  // correlationId vem do header (ou é gerado) e vai para todos os logs da requisição
  app.use((req: Request, _res: unknown, proximo: NextFunction) => {
    contextoDoLog.run({ correlationId: req.header('x-correlation-id') || crypto.randomUUID() }, proximo);
  });

  // workers terminam o que estão fazendo, depois o banco é fechado
  app.enableShutdownHooks();

  await app.listen(config.porta);
  logger.info({ port: config.porta, workers: [...config.workers] }, 'serviço iniciado');
  return app;
}

if (import.meta.main) {
  iniciarAplicacao().catch((erro) => {
    console.error(erro);
    process.exit(1);
  });
}
