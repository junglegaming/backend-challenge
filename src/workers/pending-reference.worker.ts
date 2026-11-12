import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ResolvePendingReferencesUseCase } from "../application/resolve-pending-references.use-case";
import { APP_CONFIG, type AppConfig } from "../config/config";
import { errorFields, logger } from "../observability/logger";

/**
 * Scheduled worker that periodically reprocesses `PENDING_REFERENCE`
 * transactions with exponential backoff until their referenced transaction
 * arrives or the retry budget expires.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private inFlight?: Promise<number>;

  constructor(
    @Inject(ResolvePendingReferencesUseCase)
    private readonly resolver: ResolvePendingReferencesUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.has("pending-ref")) {
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.inFlight) {
        this.inFlight = this.tick().finally(() => {
          this.inFlight = undefined;
        });
      }
    }, this.config.pendingReference.pollIntervalMs);
    logger.info("Pending-reference worker started");
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    logger.info("Pending-reference worker stopped");
  }

  async tick(limit = 20): Promise<number> {
    try {
      return await this.resolver.executeBatch(limit);
    } catch (error) {
      logger.warn({ ...errorFields(error) }, "Pending-reference worker tick failed");
      return 0;
    }
  }
}

