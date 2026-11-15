import { describe, expect, test } from 'bun:test';
import { type AdmissionOutcome, WalletAdmission, WalletBusyError } from '../../src/application/wallet-admission';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('WalletAdmission (per-wallet bulkhead)', () => {
  test('runs at most maxInFlight units per wallet, FIFO, and hands slots over in order', async () => {
    const admission = new WalletAdmission({ maxInFlight: 1, maxQueue: 10, maxWaitMs: 1_000 });
    const gate = deferred();
    const order: number[] = [];
    let concurrent = 0;
    let peak = 0;
    const job = (id: number, wait?: Promise<void>) =>
      admission.run('w1', async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        if (wait) await wait;
        order.push(id);
        concurrent--;
      });

    const all = [job(1, gate.promise), job(2), job(3), job(4)];
    await Bun.sleep(10);
    expect(order).toEqual([]); // 2..4 wait behind 1 without running
    gate.resolve();
    await Promise.all(all);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(1);
    expect(admission.activeWallets()).toBe(0); // idle lanes are dropped
  });

  test('different wallets never wait for each other', async () => {
    const admission = new WalletAdmission({ maxInFlight: 1, maxQueue: 10, maxWaitMs: 1_000 });
    const gate = deferred();
    const hot = admission.run('hot', () => gate.promise);
    let coldDone = false;
    await admission.run('cold', async () => {
      coldDone = true;
    });
    expect(coldDone).toBe(true);
    gate.resolve();
    await hot;
  });

  test('a full queue is refused immediately with a transient error', async () => {
    const outcomes: AdmissionOutcome[] = [];
    const admission = new WalletAdmission({ maxInFlight: 1, maxQueue: 2, maxWaitMs: 1_000 }, (o) => outcomes.push(o));
    const gate = deferred();
    const running = [admission.run('w', () => gate.promise), admission.run('w', async () => {}), admission.run('w', async () => {})];
    const overflow = admission.run('w', async () => {});
    await expect(overflow).rejects.toBeInstanceOf(WalletBusyError);
    await expect(overflow).rejects.toMatchObject({ category: 'transient', reason: 'hot-wallet' });
    gate.resolve();
    await Promise.all(running);
    expect(outcomes).toEqual(['immediate', 'queued', 'queued', 'rejected']);
  });

  test('a waiter that exceeds maxWaitMs is refused and leaves the queue', async () => {
    const admission = new WalletAdmission({ maxInFlight: 1, maxQueue: 10, maxWaitMs: 30 });
    const gate = deferred();
    const holder = admission.run('w', () => gate.promise);
    await expect(admission.run('w', async () => 'never')).rejects.toBeInstanceOf(WalletBusyError);
    gate.resolve();
    await holder;
    expect(await admission.run('w', async () => 'later')).toBe('later');
    expect(admission.activeWallets()).toBe(0);
  });

  test('a failing unit of work releases its slot', async () => {
    const admission = new WalletAdmission({ maxInFlight: 1, maxQueue: 10, maxWaitMs: 1_000 });
    await expect(admission.run('w', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await admission.run('w', async () => 42)).toBe(42);
  });
});
