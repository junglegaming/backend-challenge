import { Global, Module } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { NoopSyncPoint, SyncPointPort } from "../application/sync-point";
import { BlockingSyncPoint } from "./blocking-sync-point";

@Global()
@Module({
  providers: [
    {
      provide: SyncPointPort,
      inject: [Configuration],
      useFactory: (config: Configuration) =>
        config.values.sync.points.length ? new BlockingSyncPoint(config) : new NoopSyncPoint(),
    },
  ],
  exports: [SyncPointPort],
})
export class SyncPointModule {}
