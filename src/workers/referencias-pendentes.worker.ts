import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Logger } from '../utils/logger';
import { LoopPeriodico } from '../utils/utilitarios';
import { CONFIGURACAO, type Configuracao } from '../config';
import { ApostasService } from '../services/apostas.service';

/** De tempos em tempos, tenta de novo as transações que esperam a referência chegar. */
@Injectable()
export class ReferenciasPendentesWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: LoopPeriodico;

  constructor(
    apostasService: ApostasService,
    logger: Logger,
    @Inject(CONFIGURACAO) private readonly config: Configuracao,
  ) {
    this.loop = new LoopPeriodico(
      config.referenciaPendente.intervaloMs,
      () => apostasService.processarReferenciasPendentes(),
      (erro) => logger.warn({ err: erro.message }, 'falha no worker de referências pendentes'),
    );
  }

  onApplicationBootstrap() {
    if (this.config.workers.has('pending-references')) this.loop.iniciar();
  }

  async beforeApplicationShutdown() {
    await this.loop.parar();
  }
}
