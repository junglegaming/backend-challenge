import { Module } from "@nestjs/common";
import { InboxStore, OutboxWriter } from "../wagering/application/ports/messaging";
import { SqlInboxStore, SqlOutboxRepository } from "./infrastructure/repositories";

@Module({
  providers: [
    { provide: InboxStore, useClass: SqlInboxStore },
    SqlOutboxRepository,
    { provide: OutboxWriter, useExisting: SqlOutboxRepository },
  ],
  exports: [InboxStore, OutboxWriter, SqlOutboxRepository],
})
export class MessagingPersistenceModule {}
