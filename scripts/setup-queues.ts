/** Idempotently creates the FIFO queues, the DLQ and the redrive policy. Used by docker compose and tests. */
import { sqsGatewayFrom } from "../src/bootstrap";
import { loadConfig } from "../src/config/config";

const config = loadConfig({ DATABASE_URL: "postgres://unused@localhost/unused", ...process.env });
const sqs = sqsGatewayFrom(config);
for (let attempt = 1; ; attempt++) {
  try {
    await sqs.ensureQueues();
    break;
  } catch (error) {
    if (attempt >= 30) throw error;
    console.warn(`SQS not ready (attempt ${attempt}): ${(error as Error).message}`);
    await Bun.sleep(1000);
  }
}
console.log(
  JSON.stringify({
    queues: [config.SQS_WAGER_QUEUE_NAME, config.SQS_WAGER_DLQ_NAME, config.SQS_EVENTS_QUEUE_NAME],
    maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
  }),
);
sqs.destroy();
