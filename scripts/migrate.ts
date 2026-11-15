import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/infrastructure/config/app-config';
import { buildOrmConfig } from '../src/infrastructure/persistence/orm-config';

/** Usage: bun scripts/migrate.ts up|down|status */
const main = async (): Promise<void> => {
  const command = process.argv[2] ?? 'up';
  const config = loadConfig();
  const orm = await MikroORM.init(buildOrmConfig(config.DATABASE_URL, 2));
  try {
    const migrator = orm.getMigrator();
    if (command === 'up') {
      const applied = await migrator.up();
      console.log(`applied: ${applied.map((m) => m.name).join(', ') || 'nothing to apply'}`);
    } else if (command === 'down') {
      const reverted = await migrator.down();
      console.log(`reverted: ${reverted.map((m) => m.name).join(', ') || 'nothing to revert'}`);
    } else {
      console.log('executed:', (await migrator.getExecutedMigrations()).map((m) => m.name));
      console.log('pending :', (await migrator.getPendingMigrations()).map((m) => m.name));
    }
  } finally {
    await orm.close(true);
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
