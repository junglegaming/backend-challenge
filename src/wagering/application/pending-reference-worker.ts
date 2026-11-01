import { hostname } from "node:os";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { WageringTelemetry } from "../../observability/wagering-telemetry";
import { PollingLoop, pause } from "../../shared/application/polling-loop";
import { ResolvePendingTransaction } from "./resolve-pending-transaction";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private get logger() {
    return this.telemetry.logger;
  }
  private readonly instanceId = hostname();
  private readonly loop: PollingLoop;

  constructor(
    private readonly configuration: Configuration,
    private readonly resolver: ResolvePendingTransaction,
    private readonly telemetry: WageringTelemetry,
  ) {
    this.loop = new PollingLoop(
      async (signal) => {
        const result = await this.resolver.handleNextDue();
        if (!result) await pause(250, signal);
        else
          this.logger.info({
            event: "pending_reference_attempted",
            transactionId: result.transactionId,
            outcome: result.status,
            instanceId: this.instanceId,
          });
      },
      () =>
        this.logger.warning({
          event: "pending_reference_attempt_failed",
          instanceId: this.instanceId,
        }),
    );
  }

  onModuleInit(): void {
    if (this.configuration.values.role === "worker") this.loop.start();
  }

  async onModuleDestroy(): Promise<void> {
    const drained = await this.loop.stopWithin(this.configuration.values.consumer.shutdownDrainMs);
    this.logger.info({ event: "pending_worker_stopped", drained, instanceId: this.instanceId });
  }
}
