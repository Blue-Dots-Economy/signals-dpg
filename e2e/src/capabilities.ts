import type { TestType } from '@playwright/test';
import type { E2EConfig } from './config.js';

/**
 * Capability flags derived from the target config. In external mode not every
 * assertion can run against every target (a shared dev instance has no DB access,
 * can't be fault-injected, etc.). Tests declare what they need; unsupported tests
 * are SKIPPED-AND-REPORTED — never silently passed.
 */
export interface Capabilities {
  /** OTP code is retrievable headlessly (test-otp mode or an inspectable sink). */
  testOtp: boolean;
  /** An inspectable notification sink is configured. */
  notificationStub: boolean;
  /** Direct DB access for row-level introspection assertions. */
  db: boolean;
  /** Infra can be broken (stop Redis / a seam) for resilience guards. */
  faultInjection: boolean;
  /** Target runs a known SIGNALS_PII_KEY, enabling exact-jitter assertions. */
  deterministicKey: boolean;
  /** Service-caller credentials (P5/P6) are present. */
  serviceAuth: boolean;
  /** A second peer instance is configured (G3). */
  peer: boolean;
}

export function capabilitiesFor(cfg: E2EConfig): Capabilities {
  return {
    testOtp: cfg.otp.mode === 'test-otp' || (cfg.otp.mode === 'notification-stub' && !!cfg.notificationStubUrl),
    notificationStub: !!cfg.notificationStubUrl,
    db: !!cfg.db.url,
    faultInjection: cfg.faultInjection,
    deterministicKey: cfg.deterministicPiiKey,
    serviceAuth: !!cfg.auth.serviceApiKey && !!cfg.auth.actingOrgId,
    peer: !!cfg.peer.apiBaseUrl,
  };
}

/** Human-readable reasons, surfaced in the Playwright report on skip. */
const REASONS: Record<keyof Capabilities, string> = {
  testOtp: 'requires OTP retrieval (target must run CREATE_TEST_OTP or expose a notification sink)',
  notificationStub: 'requires an inspectable notification sink (notificationStubUrl)',
  db: 'requires direct DB access (config.db.url) — not available on a shared dev target',
  faultInjection: 'requires infra fault-injection (config.faultInjection) — a local instance only',
  deterministicKey: 'requires a known SIGNALS_PII_KEY (config.deterministicPiiKey) — a local instance only',
  serviceAuth: 'requires service-caller credentials (config.auth.serviceApiKey + actingOrgId)',
  peer: 'requires a second peer instance (config.peer.apiBaseUrl) — G3 only',
};

/**
 * Skip the current test (or describe block) unless every listed capability is
 * present. Use at the top of a test with the Playwright `test` object:
 *
 *   requireCapabilities(test, caps, ['db', 'deterministicKey']);
 */
export function requireCapabilities(
  test: TestType<any, any>,
  caps: Capabilities,
  needed: Array<keyof Capabilities>,
): void {
  for (const cap of needed) {
    // eslint-disable-next-line playwright/no-skipped-test -- intentional capability gating
    test.skip(!caps[cap], `[capability] ${REASONS[cap]}`);
  }
}
