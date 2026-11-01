export const invalidLoadEventsSql = `
  SELECT count(*)::int AS count FROM wager_transactions t LEFT JOIN
    (SELECT payload->'data'->>'transactionId' AS transaction_id, count(*) AS events,
      count(*) FILTER (WHERE event_type = 'WagerTransactionProcessed') AS processed_events,
      count(*) FILTER (WHERE event_type = 'WalletBalanceChanged') AS balance_events,
      bool_and((payload->>'eventType') IS NOT DISTINCT FROM event_type) AS envelope_types_match
     FROM outbox_messages GROUP BY payload->'data'->>'transactionId') e
    ON e.transaction_id = t.id::text WHERE e.events IS DISTINCT FROM 2::bigint
      OR e.processed_events IS DISTINCT FROM 1::bigint
      OR e.balance_events IS DISTINCT FROM 1::bigint
      OR e.envelope_types_match IS DISTINCT FROM true`;
