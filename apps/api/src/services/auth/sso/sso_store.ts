import { claimOnce, peekValue, putValue, takeValue } from '@/utils/one_time_store';
import type { SsoIdentity } from '@/services/auth/sso/types';

/**
 * The short-lived server-side state of one SSO login. Every key is a hashed
 * secret (see `utils/one_time_store`), so nothing here is replayable from a
 * Redis dump.
 *
 *   sso:replay:<provider>:  a partner link's token, claimed once until it expires
 *   sso:entry:              verified identity, keyed by the handle in the
 *                           browser's `sso_h` cookie and in the OIDC flow state
 *   sso:code:               a one-time authorization code for Keycloak
 */

const REPLAY_PREFIX = 'sso:replay:';
const ENTRY_PREFIX = 'sso:entry:';
const CODE_PREFIX = 'sso:code:';

/** Long enough for the Keycloak round-trip, short enough not to linger. */
export const SSO_ENTRY_TTL_SECONDS = 5 * 60;
/** A code is redeemed by Keycloak immediately; 60 s is generous. */
export const SSO_CODE_TTL_SECONDS = 60;

export interface SsoEntry {
  identity: SsoIdentity;
  /** The Keycloak username the id_token asks Keycloak to create or link. */
  preferredUsername: string;
}

export interface SsoCode {
  handle: string;
  nonce: string | null;
  redirectUri: string;
}

/** True the first time `token` is seen for `provider` within `ttlSeconds`. */
export function claimPartnerToken(
  provider: string,
  token: string,
  ttlSeconds: number
): Promise<boolean> {
  return claimOnce(`${REPLAY_PREFIX}${provider}:`, token, ttlSeconds);
}

export function saveEntry(handle: string, entry: SsoEntry): Promise<void> {
  return putValue(ENTRY_PREFIX, handle, entry, SSO_ENTRY_TTL_SECONDS);
}

/** Read by /sso/oidc/authorize and /token; the callback consumes it. */
export function peekEntry(handle: string): Promise<SsoEntry | null> {
  return peekValue<SsoEntry>(ENTRY_PREFIX, handle);
}

export function takeEntry(handle: string): Promise<SsoEntry | null> {
  return takeValue<SsoEntry>(ENTRY_PREFIX, handle);
}

export function saveCode(code: string, data: SsoCode): Promise<void> {
  return putValue(CODE_PREFIX, code, data, SSO_CODE_TTL_SECONDS);
}

export function takeCode(code: string): Promise<SsoCode | null> {
  return takeValue<SsoCode>(CODE_PREFIX, code);
}
