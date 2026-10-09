import "reflect-metadata";
import { startApplication } from "./bootstrap";
import { loadConfig } from "./config/config";

const config = loadConfig();
const app = await startApplication(config);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    const hardStop = setTimeout(() => {
      app.logger.error({ signal }, "graceful shutdown timed out; exiting");
      process.exit(1);
    }, config.SHUTDOWN_GRACE_MS + 10_000);
    hardStop.unref();
    app.shutdown(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

process.on("unhandledRejection", (reason) => {
  app.logger.error({ err: reason }, "unhandled promise rejection");
});
