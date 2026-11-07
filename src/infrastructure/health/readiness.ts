import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, 'ok' | 'down'>;
}

const CHECK_TIMEOUT_MS = 2000;

/** Readiness = the two dependencies the service cannot work without: Postgres and SQS. */
export class Readiness {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    private readonly queueUrls: string[],
    private readonly log: { warn(message: string): void } = { warn: () => undefined },
  ) {}

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe('postgres', () => this.em.getConnection().execute('select 1')),
      this.probe('sqs', async () => {
        for (const QueueUrl of this.queueUrls) {
          await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), {
            abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          });
        }
      }),
    ]);
    const checks = { postgres, sqs };
    return { status: postgres === 'ok' && sqs === 'ok' ? 'ok' : 'unavailable', checks };
  }

  private async probe(name: string, run: () => Promise<unknown>): Promise<'ok' | 'down'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'ok';
    } catch {
      this.log.warn(`readiness: ${name} check failed`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
