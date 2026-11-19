import { expect, test } from 'bun:test';
import { chunksWithDistinctAggregates } from '../../src/application/publish-outbox';
import { OutboxMessage } from '../../src/domain/messaging';

const message = (id: string, aggregateId: string) =>
  OutboxMessage.rehydrate({ id, aggregateId, eventType: 'E', payload: {}, occurredAt: new Date(), attempts: 0 });

test('outbox chunks hold at most 10 messages, one per wallet, and keep per-wallet order across chunks', () => {
  // 12 wallets com 2 eventos cada, intercalados como o banco devolve: a1 a2 b1 b2 ...
  const batch = Array.from({ length: 12 }, (_, w) => [message(`w${w}-1`, `w${w}`), message(`w${w}-2`, `w${w}`)]).flat();
  const chunks = chunksWithDistinctAggregates(batch);

  expect(chunks.flat()).toHaveLength(batch.length); // nada perdido nem duplicado
  expect(new Set(chunks.flat().map((m) => m.id)).size).toBe(batch.length);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(10);
    expect(new Set(chunk.map((m) => m.aggregateId)).size).toBe(chunk.length);
  }
  const position = new Map(chunks.flatMap((chunk, index) => chunk.map((m) => [m.id, index] as const)));
  for (let w = 0; w < 12; w++) expect(position.get(`w${w}-1`)!).toBeLessThan(position.get(`w${w}-2`)!);
});
