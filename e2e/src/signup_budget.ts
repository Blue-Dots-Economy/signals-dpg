import type { TestType } from '@playwright/test';
import { SignupRateLimitedError } from './auth.js';

/**
 * Degrade honestly when the target's self-signup budget is spent.
 *
 * `MAX_PER_IP = 10` per hour is a hardcoded constant in
 * `services/auth/self_signup.ts`, so a target can't be tuned for testing and a
 * full API run (~7 signups) can only happen once an hour. Reporting that as a
 * FAILURE is a false red: nothing regressed, the runner simply ran out of
 * budget — and a gate that cries wolf is one people learn to ignore.
 *
 * **Locally** it becomes a skip carrying the full explanation and the escape
 * hatch. **In CI it still fails**, deliberately: a P0 journey that silently
 * skips forever is exactly how journey C rotted unnoticed, and on CI an
 * exhausted budget means the pipeline is misconfigured (shared egress IP,
 * no per-run reset) — which someone needs to see.
 *
 * Usage — wrap the persona-creating step, not the assertions:
 *
 *   const u = await createLiveProfileUser(...).catch((e) => skipIfSignupExhausted(test, e));
 */
export function skipIfSignupExhausted(test: TestType<any, any>, err: unknown): never {
  if (err instanceof SignupRateLimitedError && !process.env.CI) {
    // eslint-disable-next-line playwright/no-skipped-test -- environment budget, not a product signal
    test.skip(true, `[signup budget] ${err.message}`);
  }
  throw err;
}
