import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { DynamicModule, Module, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from './utils/logger';
import { MetricasService } from './utils/metricas.service';
import { criarClienteSqs, garantirFilas, URLS_DAS_FILAS } from './utils/cliente-sqs';
import { CONFIGURACAO, type Configuracao } from './config';
import { SaudeController } from './controllers/saude.controller';
import { ApostasController } from './controllers/apostas.controller';
import { CarteirasController } from './controllers/carteiras.controller';
import { criarOrm } from './database/mikro-orm.config';
import { UnidadeDeTrabalho } from './repositories/unidade-de-trabalho';
import { ApostasService } from './services/apostas.service';
import { CarteirasService } from './services/carteiras.service';
import { PublicadorOutboxWorker } from './workers/publicador-outbox.worker';
import { ReferenciasPendentesWorker } from './workers/referencias-pendentes.worker';
import { ConsumidorDeApostasWorker } from './workers/consumidor-de-apostas.worker';

@Module({})
export class AppModule implements OnApplicationShutdown {
  static forRoot(config: Configuracao): DynamicModule {
    return {
      module: AppModule,
      controllers: [CarteirasController, ApostasController, SaudeController],
      providers: [
        // infraestrutura
        { provide: CONFIGURACAO, useValue: config },
        { provide: Logger, useValue: new Logger(config.nivelDeLog) },
        { provide: MetricasService, useValue: new MetricasService() },
        {
          provide: MikroORM,
          useFactory: async () => {
            const orm = await criarOrm(config.urlDoBanco, config.maxConexoesBanco);
            if (config.rodarMigrations) await orm.getMigrator().up();
            return orm;
          },
        },
        { provide: SQSClient, useFactory: () => criarClienteSqs(config.sqs) },
        {
          provide: URLS_DAS_FILAS,
          inject: [SQSClient],
          useFactory: (sqs: SQSClient) => garantirFilas(sqs, config.sqs),
        },
        UnidadeDeTrabalho,
        // regras de negócio
        CarteirasService,
        ApostasService,
        // workers (cada um só liga se estiver em WORKERS)
        ConsumidorDeApostasWorker,
        PublicadorOutboxWorker,
        ReferenciasPendentesWorker,
      ],
    };
  }

  constructor(private readonly orm: MikroORM) {}

  /** Roda depois que os workers terminaram (beforeApplicationShutdown): fecha o pool do banco. */
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
