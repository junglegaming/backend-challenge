import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/config";
import { errorFields, logger, NestPinoLogger } from "./observability/logger";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config), {
    logger: new NestPinoLogger(),
  });

  // Ensures OnModuleDestroy hooks run on SIGTERM / SIGINT (draining SQS consumer and workers before closing DB).
  app.enableShutdownHooks();

  if (config.roles.has("api")) {
    await app.listen(config.port, "0.0.0.0");
    logger.info(
      { port: config.port, roles: [...config.roles], instanceId: config.instanceId },
      "Wagering processor listening",
    );
  } else {
    await app.init();
    logger.info(
      { roles: [...config.roles], instanceId: config.instanceId },
      "Wagering processor worker initialized",
    );
  }
}

if (import.meta.main) {
  bootstrap().catch((error) => {
    logger.fatal({ ...errorFields(error, true) }, "Failed to bootstrap application");
    process.exit(1);
  });
}

