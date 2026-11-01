import "reflect-metadata";
import { expect, test } from "bun:test";
import type { Message } from "@aws-sdk/client-sqs";
import { parseConfiguration } from "../../src/config/config";
import { WagerConsumer } from "../../src/messaging/application/wager-consumer";
import type { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { JsonLogger } from "../../src/observability/json-logger";
import { LogContext } from "../../src/observability/log-context";
import { WageringTelemetry } from "../../src/observability/wagering-telemetry";
import { NoopSyncPoint } from "../../src/shared/application/sync-point";
import type { Database } from "../../src/shared/infrastructure/database";
import type {
  SubmissionResult,
  SubmitWagerTransaction,
} from "../../src/wagering/application/submit-wager-transaction";

test("drain expiry releases every received receipt before closing SQS, including unstarted group messages", async () => {
  const walletId = "11111111-1111-4111-8111-111111111111";
  const messages: Message[] = [1, 2, 3].map((index) => ({
    MessageId: `broker-${index}`,
    ReceiptHandle: `receipt-${index}`,
    Attributes: { MessageGroupId: walletId, ApproximateReceiveCount: "1" },
    Body: JSON.stringify({
      messageId: `message-${index}`,
      type: "WagerTransactionRequested",
      occurredAt: "2026-11-01T00:00:00Z",
      data: {
        providerId: "provider-a",
        externalTransactionId: `transaction-${index}`,
        idempotencyKey: `key-${index}`,
        playerId: "player",
        walletId,
        roundId: "round",
        gameId: "game",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      },
    }),
  }));
  const entered = Promise.withResolvers<void>();
  const processing = Promise.withResolvers<SubmissionResult>();
  const released: string[] = [];
  let releasedAtClose: string[] = [];
  let acknowledgements = 0;
  let closed = false;
  // Unit-level transport boundary; all integration scenarios use the real broker.
  const transport = {
    receive: async () => messages,
    visibility: async (_queue: string, message: Message, seconds: number) => {
      if (closed) throw new Error("Transport closed");
      expect(seconds).toBe(0);
      released.push(message.ReceiptHandle ?? "missing");
    },
    acknowledge: async () => {
      acknowledgements++;
    },
    close: () => {
      releasedAtClose = [...released];
      closed = true;
    },
  } as unknown as SqsTransport;
  const submit = {
    handle: () => {
      entered.resolve();
      return processing.promise;
    },
  } as unknown as SubmitWagerTransaction;
  const values = parseConfiguration({
    APP_ROLE: "consumer",
    SHUTDOWN_DRAIN_MS: "1",
    DB_HOST: "unused",
    DB_NAME: "unused",
    DB_USER: "unused",
    DB_PASSWORD: "unit-only",
    SQS_ENDPOINT: "http://unused:4566",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "unit",
    AWS_SECRET_ACCESS_KEY: "unit",
    AUTH_ISSUER: "http://unused/realm",
    AUTH_JWKS_URL: "http://unused/keys",
  });
  const context = new LogContext();
  const consumer = new WagerConsumer(
    { values },
    transport,
    submit,
    {} as Database,
    new NoopSyncPoint(),
    new WageringTelemetry(new JsonLogger({ values }, context), context),
  );
  consumer.onModuleInit();
  try {
    await entered.promise;
    await consumer.onModuleDestroy();
    // The runtime module closes the shared client after all runtime providers drain.
    transport.close();
    expect(releasedAtClose.sort()).toEqual(["receipt-1", "receipt-2", "receipt-3"]);
    expect(acknowledgements).toBe(0);
  } finally {
    processing.resolve({ type: "duplicate_message" });
  }
});
