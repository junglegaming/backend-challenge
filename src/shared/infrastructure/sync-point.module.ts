import { Global, Module } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { JsonLogger } from "../../observability/json-logger";
import { NoopSyncPoint, SyncPointPort } from "../application/sync-point";
import { BlockingSyncPoint } from "./blocking-sync-point";

@Global()
@Module({
  providers: [
    {
      provide: SyncPointPort,
      inject: [Configuration, JsonLogger],
      useFactory: (config: Configuration, logger: JsonLogger) =>
        config.values.sync.points.length
          ? new BlockingSyncPoint(config, logger)
          : new NoopSyncPoint(),
    },
  ],
  exports: [SyncPointPort],
})
export class SyncPointModule {}
