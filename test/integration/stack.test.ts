import { expect, test } from "bun:test";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { QUEUES } from "../../src/observability/health/dependencies";
import {
  apiUrl,
  command,
  compose,
  containersOf,
  killContainer,
  pollUntil,
  waitForLogEvent,
} from "../support/stack";

test("queue bootstrap is idempotent and provisions FIFO queues with native redrive", async () => {
  await compose(["run", "--rm", "--no-deps", "bootstrap"]);
  const sqs = new SQSClient({
    endpoint: "http://127.0.0.1:14566",
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    useQueueUrlAsEndpoint: false,
    md5: false,
  });
  try {
    for (const name of Object.values(QUEUES)) {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ["FifoQueue", "RedrivePolicy"],
        }),
      );
      expect(Attributes?.FifoQueue).toBe("true");
      if (name === QUEUES.requests) {
        const policy = JSON.parse(Attributes?.RedrivePolicy ?? "null");
        expect(String(policy.maxReceiveCount)).toBe("5");
        expect(policy.deadLetterTargetArn).toEndWith(QUEUES.deadLetters);
      }
    }
  } finally {
    sqs.destroy();
  }
});

test("real stack has 3 API, 3 consumer and 2 worker processes, and survives API loss", async () => {
  expect(process.env.WAGERING_STACK_MANAGED).toBe("1");
  for (const [role, count] of [
    ["api", 3],
    ["consumer", 3],
    ["worker", 2],
  ] as const) {
    const ids = await containersOf(role);
    expect(ids).toHaveLength(count);
    for (const id of ids) {
      const health = await command([
        "docker",
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        id,
      ]);
      expect(health.trim()).toBe("healthy");
    }
    const event = await waitForLogEvent(role, "application_started");
    expect(event.role).toBe(role);
  }
  expect((await fetch(`${apiUrl}/health/live`)).status).toBe(200);
  expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
  expect((await fetch(`${apiUrl}/metrics`)).status).toBe(404);

  const victim = (await containersOf("api"))[0];
  if (!victim) throw new Error("Missing API replica");
  await killContainer(victim);
  await pollUntil("API replica termination", async () => (await containersOf("api")).length === 2);
  const responses = await Promise.all(
    Array.from({ length: 50 }, () => fetch(`${apiUrl}/health/ready`)),
  );
  expect(responses.map((response) => response.status)).toEqual(Array(50).fill(200));
});
