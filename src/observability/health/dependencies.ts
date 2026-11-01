import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { Database } from "../../shared/infrastructure/database";

export const QUEUES = {
  requests: "wager-transactions.fifo",
  deadLetters: "wager-transactions-dlq.fifo",
  events: "wagering-events.fifo",
} as const;

@Injectable()
export class Dependencies implements OnModuleDestroy {
  readonly sqs: SQSClient;
  private closing = false;

  constructor(
    configuration: Configuration,
    private readonly database: Database,
  ) {
    const config = configuration.values;
    this.sqs = new SQSClient({
      ...config.sqs,
      credentials: { ...config.sqs.credentials },
      md5: false,
      maxAttempts: 1,
    });
  }

  async check(): Promise<boolean> {
    if (this.closing) return false;
    try {
      await Promise.all([
        this.database.orm.then((orm) => orm.em.getConnection().execute("select 1")),
        this.checkQueues(),
      ]);
      return !this.closing;
    } catch {
      return false;
    }
  }

  private async checkQueues(): Promise<void> {
    for (const name of Object.values(QUEUES)) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
        abortSignal: AbortSignal.timeout(2000),
      });
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
        {
          abortSignal: AbortSignal.timeout(2000),
        },
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.sqs.destroy();
  }
}
