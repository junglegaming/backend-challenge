import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import pino from "pino";
import { databaseOptions } from "../../mikro-orm.config";
import { parseConfiguration } from "../config/config";
import { QUEUES } from "../observability/health/dependencies";

const logger = pino();
const config = parseConfiguration(process.env);
const sqs = new SQSClient({
  ...config.sqs,
  credentials: { ...config.sqs.credentials },
  md5: false,
});
try {
  const orm = await MikroORM.init(databaseOptions(config.database));
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
  const deadLetter = await sqs.send(
    new CreateQueueCommand({
      QueueName: QUEUES.deadLetters,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }),
  );
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetter.QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error("Missing dead letter queue ARN");
  await sqs.send(
    new CreateQueueCommand({
      QueueName: QUEUES.requests,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        ReceiveMessageWaitTimeSeconds: "20",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
      },
    }),
  );
  await sqs.send(
    new CreateQueueCommand({
      QueueName: QUEUES.events,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }),
  );
  logger.info({ event: "bootstrap_completed" });
} catch (error) {
  logger.error({
    event: "bootstrap_failed",
    errorCode: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
} finally {
  sqs.destroy();
}
