import { IsolationLevel, UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { ErroDeConcorrencia, ErroTemporario } from '../utils/erros';
import { MetricasService } from '../utils/metricas.service';
import { CONFIGURACAO, type Configuracao } from '../config';
import { MensagensInboxRepository } from './mensagens-inbox.repository';
import { LancamentosRepository } from './lancamentos.repository';
import { MensagensOutboxRepository } from './mensagens-outbox.repository';
import { TransacoesRepository } from './transacoes.repository';
import { CarteirasRepository } from './carteiras.repository';

/** Repositórios que usam a mesma transação SQL. */
export interface Repositorios {
  carteiras: CarteirasRepository;
  transacoes: TransacoesRepository;
  lancamentos: LancamentosRepository;
  inbox: MensagensInboxRepository;
  outbox: MensagensOutboxRepository;
}

/**
 * Abre uma transação SQL, entrega os repositórios e faz commit no final.
 * Se qualquer coisa lançar erro, nada é gravado (rollback).
 */
@Injectable()
export class UnidadeDeTrabalho {
  constructor(
    private readonly orm: MikroORM,
    private readonly metricas: MetricasService,
    @Inject(CONFIGURACAO) private readonly config: Configuracao,
  ) {}

  async executar<T>(trabalho: (repos: Repositorios) => Promise<T>, nivelDeIsolamento?: IsolationLevel): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // não esperar um lock para sempre: depois do limite vira falha temporária (503)
          await em.execute(`select set_config('lock_timeout', ?, true)`, [`${this.config.limiteDeLockMs}ms`]);
          return trabalho({
            carteiras: new CarteirasRepository(em),
            transacoes: new TransacoesRepository(em),
            lancamentos: new LancamentosRepository(em),
            inbox: new MensagensInboxRepository(em),
            outbox: new MensagensOutboxRepository(em),
          });
        },
        { isolationLevel: nivelDeIsolamento },
      );
    } catch (erro) {
      throw this.traduzirErro(erro);
    }
  }

  /** Converte erros do Postgres em erros que a aplicação sabe tratar. */
  private traduzirErro(erro: unknown): unknown {
    const codigo = String((erro as { code?: string })?.code ?? '');
    const mensagem = (erro as Error)?.message ?? '';

    if (erro instanceof UniqueConstraintViolationException) {
      return new ErroDeConcorrencia('unique_violation', (erro as { constraint?: string }).constraint);
    }
    if (codigo === '40P01' || codigo === '40001') return new ErroDeConcorrencia('deadlock');
    if (codigo === '55P03') {
      this.metricas.conflitosDeConcorrencia.inc({ reason: 'lock_timeout' });
      return new ErroTemporario('lock_timeout');
    }
    const bancoForaDoAr =
      codigo.startsWith('08') ||
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '57P03', '53300'].includes(codigo) ||
      /Timeout acquiring a connection|Connection terminated/.test(mensagem);
    if (bancoForaDoAr) return new ErroTemporario('database_unavailable');
    return erro;
  }
}
