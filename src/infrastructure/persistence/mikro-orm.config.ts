import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { schemas } from './entities/schemas';
import { migrations } from './migrations';

export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: schemas,
    // Relations are scalar FKs (no lazy references); joined is the safe default if relations are ever added.
    loadStrategy: 'joined',
    extensions: [Migrator],
    migrations: { tableName: 'mikro_orm_migrations', migrationsList: migrations, transactional: true, snapshot: false },
  });
}
