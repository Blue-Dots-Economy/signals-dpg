import { describe, it, expect } from 'vitest';
import { CallGuard } from '../call_guard.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('CallGuard', () => {
  it('runs a call and returns its result', async () => {
    const guard = new CallGuard({ maxConcurrent: 2, failureThreshold: 3, openMs: 1000 });
    expect(await guard.run(async () => 42)).toEqual({ ok: true, value: 42 });
  });

  it('refuses beyond maxConcurrent without running the call', async () => {
    const guard = new CallGuard({ maxConcurrent: 1, failureThreshold: 3, openMs: 1000 });
    const gate = deferred();
    const first = guard.run(() => gate.promise);
    let ran = false;
    expect(
      await guard.run(async () => {
        ran = true;
      })
    ).toEqual({ ok: false, reason: 'busy' });
    expect(ran).toBe(false);
    gate.resolve();
    await first;
  });

  it('opens after failureThreshold consecutive failures and closes after openMs', async () => {
    let now = 0;
    const guard = new CallGuard({
      maxConcurrent: 5,
      failureThreshold: 2,
      openMs: 1000,
      now: () => now,
    });
    const fail = async () => {
      throw new Error('down');
    };
    expect(await guard.run(fail)).toMatchObject({ ok: false, reason: 'failed' });
    expect(await guard.run(fail)).toMatchObject({ ok: false, reason: 'failed' });
    expect(await guard.run(async () => 1)).toEqual({ ok: false, reason: 'open' });
    now = 1001;
    expect(await guard.run(async () => 1)).toEqual({ ok: true, value: 1 });
  });

  it('a success resets the failure count', async () => {
    const guard = new CallGuard({ maxConcurrent: 5, failureThreshold: 2, openMs: 1000 });
    const fail = async () => {
      throw new Error('down');
    };
    await guard.run(fail);
    await guard.run(async () => 1);
    await guard.run(fail);
    expect(await guard.run(async () => 2)).toEqual({ ok: true, value: 2 });
  });

  it('half-open lets exactly one probe through; concurrent callers stay refused', async () => {
    let now = 0;
    const guard = new CallGuard({ maxConcurrent: 5, failureThreshold: 1, openMs: 1000, now: () => now });
    await guard.run(async () => {
      throw new Error('down');
    });
    now = 1001;

    const gate = deferred();
    let calls = 0;
    const probe = guard.run(async () => {
      calls += 1;
      await gate.promise;
      return 'probe';
    });
    const others = await Promise.all(
      [1, 2, 3].map(() =>
        guard.run(async () => {
          calls += 1;
          return 'other';
        })
      )
    );
    expect(others).toEqual([
      { ok: false, reason: 'open' },
      { ok: false, reason: 'open' },
      { ok: false, reason: 'open' },
    ]);
    gate.resolve();
    expect(await probe).toEqual({ ok: true, value: 'probe' });
    expect(calls).toBe(1);
    // Probe succeeded → closed: normal calls flow again.
    expect(await guard.run(async () => 2)).toEqual({ ok: true, value: 2 });
  });

  it('a failed probe re-opens the guard for another window', async () => {
    let now = 0;
    const guard = new CallGuard({ maxConcurrent: 5, failureThreshold: 3, openMs: 1000, now: () => now });
    const fail = async () => {
      throw new Error('down');
    };
    await guard.run(fail);
    await guard.run(fail);
    await guard.run(fail); // opens
    now = 1001;
    expect(await guard.run(fail)).toMatchObject({ ok: false, reason: 'failed' }); // probe fails
    expect(await guard.run(async () => 1)).toEqual({ ok: false, reason: 'open' });
    now = 2002;
    expect(await guard.run(async () => 1)).toEqual({ ok: true, value: 1 });
  });
});
