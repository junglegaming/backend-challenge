import { config } from '../config';
import { logger } from '../observability/logger';

/** Laço de worker: roda `work` em sequência; dorme `idleMs` quando não há nada a fazer. */
export class Poller {
  private stopped = false;
  private loop?: Promise<void>;

  constructor(
    private readonly name: string,
    private readonly work: () => Promise<number>,
    private readonly idleMs: number,
  ) {}

  start(): void {
    this.loop = (async () => {
      while (!this.stopped) {
        let done = 0;
        try {
          done = await this.work();
        } catch (error) {
          logger.error({ worker: this.name, err: error }, 'worker iteration failed');
        }
        if (done === 0 && !this.stopped) await Bun.sleep(this.idleMs);
      }
    })();
  }

  /** Espera a iteração em andamento terminar, até o teto de shutdown. Interromper é seguro: tudo é transacional. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.race([this.loop, Bun.sleep(config.shutdownTimeoutMs)]);
  }
}
