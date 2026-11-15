import { TransientInfrastructureError } from './errors';

export interface WalletAdmissionOptions {
  /** concurrent units of work per wallet on this instance (they would only queue on the row lock anyway) */
  maxInFlight: number;
  /** waiters per wallet beyond which new work is refused immediately */
  maxQueue: number;
  /** how long a waiter may wait for its turn before being refused */
  maxWaitMs: number;
}

export type AdmissionOutcome = 'immediate' | 'queued' | 'rejected';

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Lane {
  inFlight: number;
  waiters: Waiter[];
}

export class WalletBusyError extends TransientInfrastructureError {
  constructor(walletId: string, why: 'queue-full' | 'wait-timeout') {
    super('hot-wallet', `Wallet ${walletId} is busy (${why}), retry later`);
  }
}

/**
 * Per-wallet bulkhead (keyed semaphore), per instance.
 *
 * Without it, N requests for one hot wallet each borrow a database connection
 * and then sit blocked on that wallet's row lock, so a single wallet can drain
 * the pool and slow down every other wallet on the instance. Here, work beyond
 * `maxInFlight` for the same wallet waits in memory (holding no connection),
 * FIFO, with a bounded queue and a bounded wait; overflow fails fast with a
 * transient error (HTTP 503 / SQS retry).
 *
 * This is purely a scheduling optimisation: correctness still comes from the
 * row lock and the constraints in PostgreSQL. Nothing about idempotency or
 * balances is kept in memory.
 */
export class WalletAdmission {
  private readonly lanes = new Map<string, Lane>();

  constructor(
    private readonly options: WalletAdmissionOptions,
    private readonly onOutcome: (outcome: AdmissionOutcome) => void = () => undefined,
  ) {}

  async run<T>(walletId: string, work: () => Promise<T>): Promise<T> {
    await this.acquire(walletId);
    try {
      return await work();
    } finally {
      this.release(walletId);
    }
  }

  /** Lanes currently tracked (empty lanes are dropped, so this stays bounded by active wallets). */
  activeWallets(): number {
    return this.lanes.size;
  }

  private acquire(walletId: string): Promise<void> {
    const lane = this.lanes.get(walletId) ?? { inFlight: 0, waiters: [] };
    this.lanes.set(walletId, lane);

    if (lane.inFlight < this.options.maxInFlight) {
      lane.inFlight += 1;
      this.onOutcome('immediate');
      return Promise.resolve();
    }
    if (lane.waiters.length >= this.options.maxQueue) {
      this.onOutcome('rejected');
      return Promise.reject(new WalletBusyError(walletId, 'queue-full'));
    }
    this.onOutcome('queued');
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = lane.waiters.indexOf(waiter);
          if (index >= 0) lane.waiters.splice(index, 1);
          this.dropIfIdle(walletId, lane);
          this.onOutcome('rejected');
          reject(new WalletBusyError(walletId, 'wait-timeout'));
        }, this.options.maxWaitMs),
      };
      lane.waiters.push(waiter);
    });
  }

  private release(walletId: string): void {
    const lane = this.lanes.get(walletId);
    if (!lane) return;
    const next = lane.waiters.shift();
    if (next) {
      // hand the slot over directly: inFlight stays the same
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    lane.inFlight -= 1;
    this.dropIfIdle(walletId, lane);
  }

  private dropIfIdle(walletId: string, lane: Lane): void {
    if (lane.inFlight === 0 && lane.waiters.length === 0) this.lanes.delete(walletId);
  }
}

export const WALLET_ADMISSION = Symbol('WalletAdmission');
