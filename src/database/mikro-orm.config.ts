import 'reflect-metadata';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { MIGRATIONS } from './migrations';
import { ENTIDADES } from './entidades';

export type Orm = MikroORM;

export function criarOrm(databaseUrl: string, maxConexoes = 20): Promise<Orm> {
  return MikroORM.init(
    defineConfig({
      clientUrl: databaseUrl,
      entities: ENTIDADES,
      discovery: { disableDynamicFileAccess: true },
      pool: { min: 0, max: maxConexoes },
      forceUtcTimezone: true,
      allowGlobalContext: false,
      extensions: [Migrator],
      migrations: { migrationsList: MIGRATIONS, transactional: true, snapshot: false, disableForeignKeys: false },
    }),
  );
}
