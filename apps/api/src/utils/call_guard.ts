/**
 * Protects this process — and the upstream it calls — from a slow or failing
 * third-party API: a concurrency cap plus a circuit breaker.
 *
 * - `maxConcurrent` in flight at once; the next caller is refused (`busy`)
 *   rather than queued, so a traffic spike cannot pile up sockets.
 * - After `failureThreshold` consecutive failures the guard opens for
 *   `openMs`, refusing immediately (`open`) instead of waiting on timeouts.
 * - When that window ends the guard is half-open: exactly ONE call goes
 *   through as a probe while every concurrent caller is still refused
 *   (`open`). The probe succeeding closes the guard; failing re-opens it for
 *   another `openMs`. Letting every waiting caller through at once would hit a
 *   recovering upstream with the whole backlog.
 *
 * A thrown error counts as a failure. Callers decide what "failure" means by
 * throwing only for upstream faults (timeouts, 5xx), not for a clean "no".
 */
export interface CallGuardOptions {
  maxConcurrent: number;
  failureThreshold: number;
  openMs: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export type CallGuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'busy' | 'open' | 'failed'; error?: unknown };

export class CallGuard {
  private inFlight = 0;
  private consecutiveFailures = 0;
  /** 0 = closed. Otherwise open until this time, then half-open. */
  private openUntil = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CallGuardOptions) {
    this.now = options.now ?? Date.now;
  }

  async run<T>(call: () => Promise<T>): Promise<CallGuardResult<T>> {
    let isProbe = false;
    if (this.openUntil !== 0) {
      if (this.now() < this.openUntil || this.probeInFlight) return { ok: false, reason: 'open' };
      isProbe = true;
    }
    if (this.inFlight >= this.options.maxConcurrent) return { ok: false, reason: 'busy' };

    this.inFlight += 1;
    if (isProbe) this.probeInFlight = true;
    try {
      const value = await call();
      this.consecutiveFailures = 0;
      this.openUntil = 0;
      return { ok: true, value };
    } catch (error) {
      this.consecutiveFailures += 1;
      if (isProbe || this.consecutiveFailures >= this.options.failureThreshold) {
        this.openUntil = this.now() + this.options.openMs;
        this.consecutiveFailures = 0;
      }
      return { ok: false, reason: 'failed', error };
    } finally {
      this.inFlight -= 1;
      if (isProbe) this.probeInFlight = false;
    }
  }
}
