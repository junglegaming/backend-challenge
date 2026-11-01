import { Configuration } from "../../config/config";
import { JsonLogger } from "../../observability/json-logger";
import { SyncPointContext, SyncPointPort } from "../application/sync-point";

export class BlockingSyncPoint extends SyncPointPort {
  private closing = false;
  private readonly waiting = new Set<() => void>();

  constructor(
    private readonly configuration: Configuration,
    private readonly logger: JsonLogger,
  ) {
    super();
  }

  override async reach(point: string, context: SyncPointContext): Promise<void> {
    const config = this.configuration.values.sync;
    if (
      this.closing ||
      !config.points.includes(point) ||
      config.match !== context.operationId ||
      context.attempt !== 1
    )
      return;
    this.logger.info({ event: "sync_point_reached", point, ...context });
    await new Promise<void>((resolve) => {
      this.waiting.add(resolve);
    });
  }
  override shutdown(): void {
    this.closing = true;
    for (const resolve of this.waiting) resolve();
    this.waiting.clear();
  }
}
