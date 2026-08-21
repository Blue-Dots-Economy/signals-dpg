import { describe, it, expect, beforeEach } from 'vitest';
import { setPendingConsent, takePendingConsent, clearPendingConsent } from './pending-consent';
import type { ConsentAcceptBody } from '@dpg/schemas';

const NOW = 1_700_000_000_000;

const body: ConsentAcceptBody = {
  network: 'edtech',
  brand: null,
  source: 'signup',
  items: [{ category: 'terms', version: 1 }],
};

describe('pending-consent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('hands the accepted consent across the Keycloak redirect', () => {
    setPendingConsent(body, NOW);
    expect(takePendingConsent(NOW + 1_000)).toEqual(body);
  });

  it('reads once — a second read after the callback has flushed it finds nothing', () => {
    setPendingConsent(body, NOW);
    takePendingConsent(NOW);
    expect(takePendingConsent(NOW)).toBeNull();
  });

  it('returns null when no acceptance was parked', () => {
    expect(takePendingConsent(NOW)).toBeNull();
  });

  it('discards a corrupt payload instead of retrying forever', () => {
    localStorage.setItem('pendingConsent', '{not json');
    expect(takePendingConsent(NOW)).toBeNull();
    expect(localStorage.getItem('pendingConsent')).toBeNull();
  });

  it('ignores a payload with no body', () => {
    localStorage.setItem('pendingConsent', JSON.stringify({ at: NOW }));
    expect(takePendingConsent(NOW)).toBeNull();
  });

  it('ignores a payload with no timestamp rather than trusting it forever', () => {
    localStorage.setItem('pendingConsent', JSON.stringify({ body }));
    expect(takePendingConsent(NOW)).toBeNull();
  });

  /**
   * Regression guard for a Critical found in the sibling aggregator repo
   * (apps/web): there, a "Register another" affordance reset the form but not
   * the accepted-consent flag, so participant #2 onward inherited consent as
   * already given with no documents shown. Signals has no such affordance, but
   * this module has the equivalent risk: `createAccountAndSignIn` parks an
   * accepted consent here and hands off to Keycloak's hosted pages — a
   * full-page navigation this app cannot observe. If that tab is abandoned
   * there (closed, walked away from, given up on) rather than completed, the
   * entry sits in `localStorage` — shared by every tab on the device,
   * unlike router state — until picked up by WHATEVER Keycloak callback
   * completes next, on that device, for whoever that turns out to be. Without
   * a staleness check that person's account would get this consent recorded
   * as accepted despite never having seen the documents. This asserts the read
   * side actually drops the entry once it's stale, not merely that a
   * staleness field exists somewhere.
   */
  it('drops an acceptance parked long enough ago to belong to an abandoned, unrelated login attempt', () => {
    setPendingConsent(body, NOW);
    // One user parks it, then a different login completes minutes later, on
    // the same device, well past a normal Keycloak round-trip.
    expect(takePendingConsent(NOW + 6 * 60 * 1000)).toBeNull();
    // And the read-once contract still holds for the dropped entry — it must
    // not be sitting there to ambush a THIRD login either.
    expect(localStorage.getItem('pendingConsent')).toBeNull();
  });

  it('keeps an acceptance that is still inside the round-trip window', () => {
    setPendingConsent(body, NOW);
    expect(takePendingConsent(NOW + 4 * 60 * 1000)).toEqual(body);
  });

  it('clearPendingConsent removes a parked acceptance outright', () => {
    setPendingConsent(body, NOW);
    clearPendingConsent();
    expect(takePendingConsent(NOW)).toBeNull();
  });
});
