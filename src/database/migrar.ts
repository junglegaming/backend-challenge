import { carregarConfiguracao } from '../config';
import { criarOrm } from './mikro-orm.config';

/** Uso: bun run migration:up | bun run migration:down (desfaz a última). */
const direcao = process.argv[2] ?? 'up';
const orm = await criarOrm(carregarConfiguracao().urlDoBanco, 2);
try {
  const migrador = orm.getMigrator();
  const resultado = direcao === 'down' ? await migrador.down() : await migrador.up();
  console.log(`migrations ${direcao}:`, resultado.map((m) => m.name).join(', ') || 'nada a fazer');
} finally {
  await orm.close();
}
