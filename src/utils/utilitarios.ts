import { createHash } from 'node:crypto';
import { ErroDeConcorrencia } from './erros';

/** UUIDv7: único e ordenado no tempo (bom para índices). */
export function novoId(): string {
  return Bun.randomUUIDv7();
}

/** SHA-256 do JSON com as chaves em ordem alfabética (o mesmo objeto sempre gera o mesmo hash). */
export function hashDoJson(valor: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordenarChaves(valor))).digest('hex');
}

function ordenarChaves(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenarChaves);
  if (valor === null || typeof valor !== 'object') return valor;
  return Object.fromEntries(
    Object.keys(valor)
      .sort()
      .filter((chave) => (valor as Record<string, unknown>)[chave] !== undefined)
      .map((chave) => [chave, ordenarChaves((valor as Record<string, unknown>)[chave])]),
  );
}

/**
 * Repete `funcao` quando ela perde uma corrida no banco (ErroDeConcorrencia).
 * A nova tentativa já enxerga o resultado de quem ganhou. Limite: 5 vezes.
 */
export async function repetirSeHouverConflito<T>(
  funcao: () => Promise<T>,
  aoRepetir: (erro: ErroDeConcorrencia) => void,
): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await funcao();
    } catch (erro) {
      if (!(erro instanceof ErroDeConcorrencia) || tentativa >= 5) throw erro;
      aoRepetir(erro);
      await Bun.sleep(Math.random() * 10 * tentativa); // espera aleatória curta para não colidir de novo
    }
  }
}

/** Roda `tarefa` em loop, com uma pausa entre as execuções, até `parar()`. */
export class LoopPeriodico {
  private rodando = false;
  private terminou?: Promise<void>;

  constructor(
    private readonly intervaloMs: number,
    private readonly tarefa: () => Promise<unknown>,
    private readonly aoFalhar: (erro: Error) => void,
  ) {}

  iniciar(): void {
    this.rodando = true;
    this.terminou = this.repetir();
  }

  /** Para e espera a execução atual terminar. */
  async parar(): Promise<void> {
    this.rodando = false;
    await this.terminou;
  }

  private async repetir(): Promise<void> {
    while (this.rodando) {
      await this.tarefa().catch((erro) => this.aoFalhar(erro as Error));
      await Bun.sleep(this.intervaloMs);
    }
  }
}
