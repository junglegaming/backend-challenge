import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { UnitOfWork } from '../../src/application/ports/wagering-repositories.port';
import { OpenWallet } from '../../src/application/wagering/open-wallet';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SqlOutboxPublisherStore } from '../../src/infrastructure/persistence/outbox-publisher-store';
import { createTestDatabase } from './support/test-database';

test('outbox publisher cannot see or publish uncommitted financial events', async () => {
  const db = await createTestDatabase();
  const now = new Date(Date.now() - 60_000);
  const clock = { now: () => new Date(now) };
  let release!: () => void;
  let ready!: () => void;
  const paused = new Promise<void>((resolve) => { ready = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const actual = new MikroOrmUnitOfWork(db.orm.em);
  const uow: UnitOfWork = {
    run: (work) => actual.run(async (repositories) => {
      const result = await work(repositories);
      ready();
      await resume;
      return result;
    }),
  };
  let published = 0;
  const publisher = new PublishOutbox(new SqlOutboxPublisherStore(db.orm.em),
    { publish: async () => { published++; } }, clock, { error: () => {} });
  const opening = new OpenWallet(uow, clock, { next: randomUUID })
    .execute({ playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } });
  try {
    await paused;
    expect(await publisher.runOne()).toBe(false);
    expect(published).toBe(0);
    release();
    await opening;
    expect(await publisher.runOne()).toBe(true);
    expect(published).toBe(1);
  } finally {
    release();
    await opening;
    await db.drop();
  }
});
