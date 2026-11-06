import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config/app-config';
import { buildOrmConfig } from './mikro-orm.config';

const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(buildOrmConfig(loadConfig().databaseUrl));

try {
  if (command === 'up') {
    const applied = await orm.migrator.up();
    console.log(`applied: ${applied.map((m) => m.name).join(', ') || 'none'}`);
  } else if (command === 'down') {
    const reverted = await orm.migrator.down();
    console.log(`reverted: ${reverted.map((m) => m.name).join(', ') || 'none'}`);
  } else if (command === 'status') {
    console.log(JSON.stringify(await orm.migrator.getExecuted(), null, 2));
  } else {
    throw new Error(`Unknown command "${command}" (use up | down | status)`);
  }
} finally {
  await orm.close();
}
