import { loadConfig } from '../src/infrastructure/config/app-config';
import { SqsGateway } from '../src/infrastructure/messaging/sqs-gateway';

/** Creates the FIFO queues (idempotent). */
const main = async (): Promise<void> => {
  const gateway = new SqsGateway(loadConfig());
  try {
    console.log(await gateway.ensureQueues());
  } finally {
    gateway.destroy();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
