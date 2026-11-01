// Both anti-joins are necessary: equal counts can conceal missing and extra identities.
export async function eventCoverage(
  connection: { execute(sql: string, params: unknown[]): Promise<unknown> },
  consumer: string,
) {
  const [row] = (await connection.execute(
    `SELECT
      (SELECT count(*)::int FROM outbox_messages) AS outbox,
      (SELECT count(*)::int FROM test_event_effects WHERE consumer_name = ?) AS effects,
      (SELECT count(*)::int FROM outbox_messages o WHERE NOT EXISTS
        (SELECT 1 FROM test_event_effects e WHERE e.consumer_name = ? AND e.event_id = o.id)) AS missing,
      (SELECT count(*)::int FROM test_event_effects e WHERE e.consumer_name <> ? OR NOT EXISTS
        (SELECT 1 FROM outbox_messages o WHERE o.id = e.event_id)) AS extra,
      (SELECT count(*)::int FROM test_event_effects e LEFT JOIN inbox_messages i
        ON i.consumer_name = e.consumer_name AND i.message_id = e.event_id::text
        WHERE i.processed_at IS NULL) +
      (SELECT count(*)::int FROM inbox_messages i WHERE i.consumer_name = ? AND NOT EXISTS
        (SELECT 1 FROM test_event_effects e WHERE e.consumer_name = i.consumer_name
          AND e.event_id::text = i.message_id)) +
      (SELECT count(*)::int FROM inbox_messages WHERE consumer_name NOT IN
        ('wager-transactions-processor', ?)) AS invalid_inbox`,
    [consumer, consumer, consumer, consumer, consumer],
  )) as {
    outbox: number;
    effects: number;
    missing: number;
    extra: number;
    invalid_inbox: number;
  }[];
  if (!row) throw new Error("Missing event coverage evidence");
  return row;
}

export function completeEventCoverage(row: Awaited<ReturnType<typeof eventCoverage>>) {
  return row.outbox === row.effects && !row.missing && !row.extra && !row.invalid_inbox;
}
