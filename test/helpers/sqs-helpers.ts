import { DeleteMessageBatchCommand, type Message, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";

export interface WagerData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerMessage(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Partial<WagerData> & { messageId?: string } = {},
) {
  const { messageId, ...dataOverrides } = extra;
  const externalTransactionId = dataOverrides.externalTransactionId ?? `tx-${Bun.randomUUIDv7()}`;
  const data: WagerData = {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...dataOverrides,
  };
  return {
    messageId: messageId ?? `msg-${Bun.randomUUIDv7()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  };
}

/**
 * Sends a wager message. `brokerDedupId` defaults to a fresh value so the broker's own 5-minute FIFO
 * de-duplication does NOT hide redeliveries — the tests must prove the persistent inbox handles them.
 */
export async function sendWager(
  sqs: SqsGateway,
  message: { messageId: string; data: { walletId: string } },
  brokerDedupId?: string,
) {
  await sqs.sendWager(JSON.stringify(message), message.data.walletId, brokerDedupId ?? Bun.randomUUIDv7());
}

export async function drainQueue(sqs: SqsGateway, queueName: string, idleRounds = 2): Promise<Message[]> {
  const url = await sqs.queueUrl(queueName);
  const all: Message[] = [];
  let idle = 0;
  while (idle < idleRounds) {
    const res = await sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
    );
    const batch = res.Messages ?? [];
    if (batch.length === 0) idle++;
    else {
      idle = 0;
      all.push(...batch);
      // FIFO: in-flight messages block the rest of their group, so acknowledge what we read.
      await sqs.client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: url,
          Entries: batch.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle ?? "" })),
        }),
      );
    }
  }
  return all;
}
