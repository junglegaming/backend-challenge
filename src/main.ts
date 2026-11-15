import { createApp } from './app';
import { loadConfig } from './infrastructure/config/app-config';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra }));

const bootstrap = async (): Promise<void> => {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.PORT, '0.0.0.0');

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutdown requested', { signal });
    // hard stop if draining takes longer than the orchestrator grace period
    const guard = setTimeout(() => {
      log('error', 'graceful shutdown timed out');
      process.exit(1);
    }, config.CONSUMER_SHUTDOWN_TIMEOUT_MS + 10_000);
    guard.unref();
    // stops HTTP, drains the SQS consumer and workers, then closes DB and SQS clients
    await app.close();
    log('info', 'shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
};

bootstrap().catch((error: unknown) => {
  log('fatal', 'bootstrap failed', { error: String(error) });
  process.exit(1);
});
