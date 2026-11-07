import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PublishOutbox } from '../../application/outbox/publish-outbox';

export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly publish: PublishOutbox, private readonly close: () => void = () => {}) {}

  onModuleInit(): void {
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    this.close();
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => { this.active = this.tick(); }, 1000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      for (let i = 0; i < 20 && !this.stopping; i++) {
        if (!(await this.publish.runOne())) break;
      }
    } catch (error) {
      this.logger.error('Outbox transaction failed; publication will be retried', error instanceof Error ? error.stack : String(error));
    } finally {
      this.schedule();
    }
  }
}
