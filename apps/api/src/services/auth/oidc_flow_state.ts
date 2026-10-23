import { createHash } from 'node:crypto';
import { allowed_origins } from '@dpg/config';
import { redis } from '@api/db/secondary/redis';

/**
 * The origins a browser may legitimately reach this API from.
 *
 * Seeded with the env allowlist and replaced at boot with the merged list CORS
 * enforces (`app.ts` adds the per-domain instance URLs from network config).
 * The env list alone would reject a portal whose origin comes from network
 * config and send that browser to a host with no UI after login.
 */
let browserOrigins: readonly string[] = allowed_origins;

export function setBrowserAllowedOrigins(origins: readonly string[]): void {
  browserOrigins = origins;
}

/**
 * The in-flight half of a login: what the callback needs to finish a flow the
 * `/login` redirect started.
 *
 * Held server-side keyed by `state`, so the PKCE verifier never reaches the
 * browser. Single-use: `consumeFlowState` deletes as it reads, so a replayed
 * callback is rejected. Short TTL: it only has to survive one Keycloak
 * round-trip.
 */

const FLOW_PREFIX = 'oidcflow:';
export const FLOW_TTL_SECONDS = 5 * 60;

export interface OidcFlowState {
  verifier: string;
  nonce: string;
  /** Path within the app to return to. Validated before use — see `safeReturnTo`. */
  returnTo: string;
  /**
   * Opaque marker the UI uses to resume a consent the user was mid-way through
   * when login interrupted it. Carried through the flow back to the callback page.
   */
  consentAttempt?: string;
  redirectUri: string;
  /** Browser origin to hand the user back to. See `safeAppOrigin`. */
  appOrigin: string;
}

/** `state` is a credential for this flow; keep it out of Redis keys in the clear. */
function flowKey(state: string): string {
  return FLOW_PREFIX + createHash('sha256').update(state).digest('hex');
}

export async function saveFlowState(
  state: string,
  data: OidcFlowState
): Promise<void> {
  await redis.set(flowKey(state), JSON.stringify(data), 'EX', FLOW_TTL_SECONDS);
}

/** Reads and deletes in one step: a `state` is good for exactly one callback. */
export async function consumeFlowState(
  state: string
): Promise<OidcFlowState | null> {
  const key = flowKey(state);
  const raw = await redis.getdel(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OidcFlowState;
  } catch {
    return null;
  }
}

/**
 * Constrains `returnTo` to a path on this origin.
 *
 * The value arrives as a query parameter on `/login`; without this check the
 * login is an open redirect. Anything not starting with a single `/` is
 * discarded, including protocol-relative `//host`.
 */
export function safeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  // The WHATWG URL parser treats a backslash as a path separator, so
  // `/\evil.test` resolves off-origin despite the checks above.
  if (raw.includes('\\')) return fallback;
  return raw;
}

/**
 * Constrains the caller-supplied app origin to one this instance already serves
 * a browser at.
 *
 * The UI and API may be on different origins, so the origin comes from the
 * request, and unchecked it would be an open redirect. Checked against the
 * CORS allowlist (`setBrowserAllowedOrigins`), so the browser can only be sent
 * to origins it may call from.
 */
export function safeAppOrigin(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  return browserOrigins.includes(raw) ? raw : fallback;
}
