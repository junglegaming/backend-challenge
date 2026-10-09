/**
 * Measures the raw SendMessageBatch throughput of the SQS endpoint alone (no app, no DB), to separate
 * emulator limits from application limits in the load-test analysis.
 *   bun run load/sqs-ceiling.ts [--sqs http://localhost:4566] [--messages 2000] [--concurrency 1,4,8]
 */
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageBatchCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const endpoint = arg("sqs", "http://localhost:4566");
const total = Number(arg("messages", "2000"));
const levels = arg("concurrency", "1,4,8").split(",").map(Number);
const sqs = new SQSClient({
  region: "us-east-1",
  endpoint,
  credentials: { accessKeyId: "t", secretAccessKey: "t" },
  md5: false,
});

for (const concurrency of levels) {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `ceiling-${Date.now()}.fifo`, Attributes: { FifoQueue: "true" } }),
  );
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        const start = next;
        next += 10;
        await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl,
            Entries: Array.from({ length: Math.min(10, total - start) }, (_, i) => ({
              Id: String(i),
              MessageBody: JSON.stringify({ n: start + i, pad: "x".repeat(400) }),
              MessageGroupId: `g-${(start + i) % 50}`,
              MessageDeduplicationId: `${start + i}-${Math.random()}`,
            })),
          }),
        );
      }
    }),
  );
  const s = (performance.now() - t0) / 1000;
  console.log(
    JSON.stringify({
      endpoint,
      concurrency,
      messages: total,
      seconds: Math.round(s * 10) / 10,
      msgPerS: Math.round(total / s),
    }),
  );
  await sqs.send(new DeleteQueueCommand({ QueueUrl }));
}
sqs.destroy();
