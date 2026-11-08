import { z } from 'zod';
import { Money } from '../domain/money';
import { ErroHttp } from './erros';

/** Texto curto: ASCII visível, sem espaços. */
export const texto = (tamanhoMaximo: number) =>
  z.string().min(1).max(tamanhoMaximo).regex(/^[\x21-\x7E]+$/, 'deve ser ASCII visível, sem espaços');

/** { amount: "25.00", currency: "BRL" }, com as mesmas regras do Money. */
export const schemaDinheiro = z
  .object({ amount: z.string(), currency: z.string() })
  .superRefine((valor, contexto) => {
    try {
      Money.from(valor);
    } catch (erro) {
      contexto.addIssue({ code: z.ZodIssueCode.custom, message: (erro as Error).message });
    }
  });

/** Valida `valor` com o schema; se falhar, lança 400 com a lista de problemas. */
export function validar<T>(schema: z.ZodType<T>, valor: unknown): T {
  const resultado = schema.safeParse(valor);
  if (!resultado.success) {
    const detalhes = resultado.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ErroHttp(400, 'VALIDATION_ERROR', 'payload inválido', detalhes);
  }
  return resultado.data;
}

/** Ids da URL são conferidos antes de ir ao banco (o Postgres daria erro com um uuid inválido). */
export function ehUuid(valor: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor);
}
