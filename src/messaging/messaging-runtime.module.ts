import { Module } from "@nestjs/common";
import { WageringModule } from "../wagering/wagering.module";
import { WagerConsumer } from "./application/wager-consumer";
import { SqsTransport } from "./infrastructure/sqs-transport";

@Module({ imports: [WageringModule], providers: [SqsTransport, WagerConsumer] })
export class MessagingRuntimeModule {}
