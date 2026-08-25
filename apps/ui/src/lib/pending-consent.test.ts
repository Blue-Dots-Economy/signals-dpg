import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  newConsentAttemptId,
  setPendingConsent,
  takePendingConsent,
  clearPendingConsent,
} from './pending-consent';
import type { ConsentAcceptBody } from '@dpg/schemas';

const NOW = 1_700_000_000_000;

/** The login that parked the acceptance. */
const ATTEMPT = 'attempt-a';
/** Somebody else's login landing on the same device. */
const OTHER_ATTEMPT = 'attempt-b';

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
    setPendingConsent(body, ATTEMPT, NOW);
    expect(takePendingConsent(ATTEMPT, NOW + 1_000)).toEqual(body);
  });

  it('reads once — a second read after the callback has flushed it finds nothing', () => {
    setPendingConsent(body, ATTEMPT, NOW);
    takePendingConsent(ATTEMPT, NOW);
    expect(takePendingConsent(ATTEMPT, NOW)).toBeNull();
  });

  it('returns null when no acceptance was parked', () => {
    expect(takePendingConsent(ATTEMPT, NOW)).toBeNull();
  });

  it('discards a corrupt payload instead of retrying forever', () => {
    localStorage.setItem('pendingConsent', '{not json');
    expect(takePendingConsent(ATTEMPT, NOW)).toBeNull();
    expect(localStorage.getItem('pendingConsent')).toBeNull();
  });

  it('ignores a payload with no body', () => {
    localStorage.setItem('pendingConsent', JSON.stringify({ at: NOW, attempt: ATTEMPT }));
    expect(takePendingConsent(ATTEMPT, NOW)).toBeNull();
  });

  it('ignores a payload with no timestamp rather than trusting it forever', () => {
    localStorage.setItem('pendingConsent', JSON.stringify({ body, attempt: ATTEMPT }));
    expect(takePendingConsent(ATTEMPT, NOW)).toBeNull();
  });

  /**
   * The property that actually matters, and the one a TTL cannot give you.
   *
   * `ConsentAcceptBody` carries no subject, and `POST /consent/accept` is
   * authenticated — so the server writes the acceptance against whoever is
   * signed in and has no way to notice it came from someone else. Person A
   * accepts, is redirected to Keycloak, and abandons the tab. Person B signs in
   * on the same device *seconds later*, comfortably inside any TTL. Without the
   * identity binding, B's callback finds A's entry and files it against B, who
   * never saw the documents. That is manufactured evidence of consent, and it
   * is worse than having no record at all.
   *
   * Timing is deliberately well inside the freshness window here: this asserts
   * the binding, not the clock. If someone ever reduces `takePendingConsent` to
   * a TTL check again, this test — not the staleness one below — is what fails.
   */
  it('refuses to hand one login’s acceptance to a different login on the same device', () => {
    setPendingConsent(body, ATTEMPT, NOW);
    expect(takePendingConsent(OTHER_ATTEMPT, NOW + 1_000)).toBeNull();
  });

  /**
   * A plain sign-in parks no consent, so it arrives with no attempt id. It must
   * not therefore match a parked entry — "no id" is a non-match, not a wildcard.
   */
  it('refuses to hand a parked acceptance to a login that parked none', () => {
    setPendingConsent(body, ATTEMPT, NOW);
    expect(takePendingConsent(undefined, NOW + 1_000)).toBeNull();
  });

  /**
   * A rejected entry must not be left behind for the next login to find, or the
   * substitution simply happens one login later.
   */
  it('clears the entry even when it is rejected as belonging to another login', () => {
    setPendingConsent(body, ATTEMPT, NOW);
    takePendingConsent(OTHER_ATTEMPT, NOW + 1_000);
    expect(localStorage.getItem('pendingConsent')).toBeNull();
    // Even the rightful login cannot get it back — read-once is unconditional.
    expect(takePendingConsent(ATTEMPT, NOW + 2_000)).toBeNull();
  });

  /**
   * An entry written before this binding existed carries no `attempt`. It must
   * fail safe on read rather than be honoured, so upgrading the app cannot
   * inherit an unbound acceptance that is already sitting in someone's browser.
   */
  it('drops a pre-upgrade entry that carries no attempt id', () => {
    localStorage.setItem('pendingConsent', JSON.stringify({ body, at: NOW }));
    expect(takePendingConsent(ATTEMPT, NOW + 1_000)).toBeNull();
    expect(localStorage.getItem('pendingConsent')).toBeNull();
  });

  it('treats a blank attempt id as a non-match rather than a wildcard', () => {
    localStorage.setItem('pendingConsent', JSON.stringify({ body, at: NOW, attempt: '' }));
    expect(takePendingConsent('', NOW + 1_000)).toBeNull();
  });

  /**
   * Retained as belt-and-braces behind the identity binding above: it bounds
   * how long an abandoned entry lingers at all, rather than being the only
   * thing standing between one person's acceptance and another's record.
   */
  it('drops an acceptance parked long enough ago to belong to an abandoned login attempt', () => {
    setPendingConsent(body, ATTEMPT, NOW);
    // Even the login that parked it cannot claim it once it is stale.
    expect(takePendingConsent(ATTEMPT, NOW + 6 * 60 * 1000)).toBeNull();
    // And the read-once contract still holds for the dropped entry — it must
    // not be sitting there to ambush a THIRD login either.
    expect(localStorage.getItem('pendingConsent')).toBeNull();
  });

  it('keeps an acceptance that is still inside the round-trip window', () => {
    setPendingConsent(body, ATTEMPT, NOW);
    expect(takePendingConsent(ATTEMPT, NOW + 4 * 60 * 1000)).toEqual(body);
  });

  it('clearPendingConsent removes a parked acceptance outright', () => {
    setPendingConsent(body, ATTEMPT, NOW);
    clearPendingConsent();
    expect(takePendingConsent(ATTEMPT, NOW)).toBeNull();
  });

  describe('newConsentAttemptId', () => {
    it('does not repeat across logins on one device', () => {
      const ids = new Set(Array.from({ length: 200 }, () => newConsentAttemptId()));
      expect(ids.size).toBe(200);
    });

    it('never returns an empty id, which would read as a wildcard', () => {
      expect(newConsentAttemptId()).not.toBe('');
    });

    /**
     * There is deliberately no weak fallback. Where no CSPRNG exists the caller
     * must decline to park the acceptance rather than bind it with something
     * forgeable — so this returns null instead of degrading quietly.
     */
    it('returns null rather than a weak id when no CSPRNG is available', () => {
      const real = globalThis.crypto;
      // @ts-expect-error — deleting a readonly global for the duration of the test.
      delete globalThis.crypto;
      try {
        expect(newConsentAttemptId()).toBeNull();
      } finally {
        Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
      }
    });

    it('returns null rather than a weak id when the CSPRNG throws', () => {
      const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
        throw new Error('blocked');
      });
      try {
        expect(newConsentAttemptId()).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
