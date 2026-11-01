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
  private databaseProbe?: Promise<unknown>;
  private readonly urls = new Map<string, string>();

  constructor(
    configuration: Configuration,
    private readonly database: Database,
  ) {
    const config = configuration.values;
    this.sqs = new SQSClient({
      ...config.sqs,
      ...(config.sqs.credentials ? { credentials: { ...config.sqs.credentials } } : {}),
      md5: false,
      maxAttempts: 1,
      useQueueUrlAsEndpoint: false,
    });
  }

  async check(): Promise<boolean> {
    if (this.closing) return false;
    try {
      // At most one database probe can remain pending during a network outage.
      this.databaseProbe ??= this.database.orm
        .then((orm) => orm.em.getConnection().execute("select 1"))
        .finally(() => {
          this.databaseProbe = undefined;
        });
      await bounded(Promise.all([this.databaseProbe, this.checkQueues()]), 2000);
      return !this.closing;
    } catch {
      return false;
    }
  }

  async queueAttributes(name: string) {
    let url = this.urls.get(name);
    if (!url) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
        abortSignal: AbortSignal.timeout(2000),
      });
      if (!QueueUrl) throw new Error("Queue unavailable");
      url = QueueUrl;
      this.urls.set(name, url);
    }
    return (
      (
        await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [
              "QueueArn",
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
              "ApproximateNumberOfMessagesDelayed",
            ],
          }),
          { abortSignal: AbortSignal.timeout(2000) },
        )
      ).Attributes ?? {}
    );
  }

  private async checkQueues(): Promise<void> {
    await Promise.all(Object.values(QUEUES).map((name) => this.queueAttributes(name)));
  }

  beginShutdown(): void {
    this.closing = true;
  }

  async onModuleDestroy(): Promise<void> {
    this.beginShutdown();
    this.sqs.destroy();
  }
}

export async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Dependency probe timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
