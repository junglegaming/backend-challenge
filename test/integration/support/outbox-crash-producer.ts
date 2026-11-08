import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../../src/application/wagering/open-wallet';
import { buildOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const orm = await MikroORM.init(buildOrmConfig(url));
const open = new OpenWallet(new MikroOrmUnitOfWork(orm.em), { now: () => new Date() }, { next: randomUUID });
const wallet = await open.execute({
  playerId: randomUUID(),
  initialBalance: { amount: '10.00', currency: 'BRL' },
});
console.log(`COMMITTED:${wallet.id}`);
await new Promise(() => {});
