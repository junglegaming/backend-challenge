import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { JsonLogger } from '../observability/json-logger';
import type { RetryPendingReference } from '../../application/wagering/retry-pending-reference';

export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new JsonLogger(PendingReferenceWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly retry: RetryPendingReference) {}

  onModuleInit(): void {
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.active = this.tick();
    }, 1000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      for (let i = 0; i < 20 && !this.stopping; i++) {
        if (!(await this.retry.runOne())) break;
      }
    } catch {
      this.logger.error('Failed to retry pending reference; transaction rolled back');
    } finally {
      this.schedule();
    }
  }
}
