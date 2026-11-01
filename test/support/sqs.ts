import { randomUUID } from "node:crypto";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../src/observability/health/dependencies";
import { httpWager } from "./http";
import { pollUntil } from "./stack";

export function wagerMessage(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    messageId: randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...httpWager(wallet), idempotencyKey: randomUUID(), ...overrides },
  };
}
export async function sendWager(
  transport: SqsTransport,
  envelope: ReturnType<typeof wagerMessage>,
  body = JSON.stringify(envelope),
) {
  await transport.send(QUEUES.requests, body, envelope.data.walletId, randomUUID());
}
export async function receiveDeadLetter(transport: SqsTransport, messageId: string) {
  return pollUntil(
    `DLQ delivery ${messageId}`,
    async () => {
      const messages = await transport.receive(QUEUES.deadLetters, new AbortController().signal, 1);
      const match = messages.find((message) => {
        try {
          return JSON.parse(message.Body ?? "{}").messageId === messageId;
        } catch {
          return message.Body === messageId;
        }
      });
      for (const message of messages)
        if (message !== match) await transport.visibility(QUEUES.deadLetters, message, 0);
      return match;
    },
    40_000,
  );
}
