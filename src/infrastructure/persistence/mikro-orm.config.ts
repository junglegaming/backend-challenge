import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { migrations } from './migrations';

export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: { tableName: 'mikro_orm_migrations', migrationsList: migrations, transactional: true, snapshot: false },
  });
}
