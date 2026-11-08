/** Erro que vira resposta HTTP: 400 (validação), 404 (não encontrado), 409 (conflito). */
export class ErroHttp extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroHttp';
  }
}

/** Perdeu uma corrida no banco (unique, versão, deadlock). Dá para repetir na hora. */
export class ErroDeConcorrencia extends Error {
  constructor(
    readonly motivo: string,
    readonly restricao?: string,
  ) {
    super(`conflito de concorrência: ${motivo}${restricao ? ` (${restricao})` : ''}`);
    this.name = 'ErroDeConcorrencia';
  }
}

/** Banco indisponível ou lock demorou demais. Dá para repetir depois (HTTP 503). */
export class ErroTemporario extends Error {
  constructor(readonly motivo: string) {
    super(`falha temporária: ${motivo}`);
    this.name = 'ErroTemporario';
  }
}
