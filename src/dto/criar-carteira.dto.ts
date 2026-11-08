import { z } from 'zod';
import { schemaDinheiro } from '../utils/validacao';

export const schemaCriarCarteira = z.object({
  playerId: z.string().uuid(),
  initialBalance: schemaDinheiro,
});

export type CriarCarteiraDto = z.infer<typeof schemaCriarCarteira>;
