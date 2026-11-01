import { Module, OnModuleDestroy } from "@nestjs/common";
import { PendingReferenceWorker } from "../wagering/application/pending-reference-worker";
import { WageringModule } from "../wagering/wagering.module";
import { OutboxPublisher } from "./application/outbox-publisher";
import { WagerConsumer } from "./application/wager-consumer";
import { SqsTransport } from "./infrastructure/sqs-transport";
import { MessagingPersistenceModule } from "./messaging-persistence.module";

@Module({
  imports: [WageringModule, MessagingPersistenceModule],
  providers: [SqsTransport, WagerConsumer, OutboxPublisher, PendingReferenceWorker],
})
export class MessagingRuntimeModule implements OnModuleDestroy {
  constructor(private readonly transport: SqsTransport) {}
  onModuleDestroy(): void {
    this.transport.close();
  }
}
