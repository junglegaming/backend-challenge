export interface SyncPointContext {
  operationId: string;
  instanceId: string;
  attempt: number;
}
export abstract class SyncPointPort {
  abstract reach(point: string, context: SyncPointContext): Promise<void>;
  abstract shutdown(): void;
}
export class NoopSyncPoint extends SyncPointPort {
  override async reach(_point: string, _context: SyncPointContext): Promise<void> {}
  override shutdown(): void {}
}
