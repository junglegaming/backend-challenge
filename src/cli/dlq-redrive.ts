import { randomUUID } from "node:crypto";
import pino from "pino";
import { Configuration } from "../config/config";
import { SqsTransport } from "../messaging/infrastructure/sqs-transport";
import { QUEUES } from "../observability/health/dependencies";

const transport = new SqsTransport(new Configuration());
const logger = pino();
let moved = 0;
try {
  for (;;) {
    const messages = await transport.receive(QUEUES.deadLetters, new AbortController().signal, 1);
    if (!messages.length) break;
    for (const message of messages) {
      await transport.send(
        QUEUES.requests,
        message.Body ?? "",
        message.Attributes?.MessageGroupId ?? randomUUID(),
        randomUUID(),
      );
      await transport.acknowledge(QUEUES.deadLetters, message);
      moved++;
    }
  }
  logger.info({ event: "dlq_redrive_completed", moved });
} catch {
  logger.error({ event: "dlq_redrive_failed", moved });
  process.exitCode = 1;
} finally {
  transport.close();
}
