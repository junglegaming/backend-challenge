import { MikroORM } from '@mikro-orm/postgresql';
import { ormConfig } from './orm';

// bun run migrate | bun run migrate:down
const direction = process.argv[2] === 'down' ? 'down' : 'up';
const orm = await MikroORM.init(ormConfig());
const applied = await orm.migrator[direction]();
console.log(`${direction}:`, applied.map((m) => m.name));
await orm.close();
