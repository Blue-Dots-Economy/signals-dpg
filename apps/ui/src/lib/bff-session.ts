import { apiConfig } from './api-config';

/**
 * Client half of the httpOnly-cookie session. The browser holds an opaque
 * `sid` cookie it cannot read; the access and refresh tokens live in Redis on
 * the API. This module knows only whether a session exists and the CSRF token
 * to echo on state-changing requests. The CSRF token is readable by script by
 * design: a cross-site page can make the browser send the cookie but cannot
 * read this response to learn the token.
 */

export interface BffSession {
  authenticated: boolean;
  csrfToken?: string;
  /**
   * The server could not answer; this does not mean the session is gone. The
   * API answers a Keycloak or Redis outage with 503 rather than 401, so the
   * caller should keep its existing state when this is set.
   */
  unknown?: boolean;
}

/** In-memory only. A reload re-reads it from the API; nothing is persisted. */
let csrfToken: string | null = null;

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}

function url(path: string): string {
  return `${apiConfig.getUrl()}${path}`;
}

/**
 * Asks the API whether this browser has a session. `credentials: 'include'` is
 * needed because in local development the UI and API are on different origins.
 */
export async function fetchBffSession(): Promise<BffSession> {
  try {
    const response = await fetch(url('/api/v1/auth/session'), {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      // A 5xx means the API could not reach its dependencies; the session may
      // still be alive. Keep the CSRF token and report the answer as unknown.
      if (response.status >= 500) return { authenticated: false, unknown: true };
      // 401/403/404: the session is gone or never existed.
      csrfToken = null;
      return { authenticated: false };
    }
    const session = (await response.json()) as BffSession;
    csrfToken = session.csrfToken ?? null;
    return session;
  } catch {
    // Could not reach the API (offline, DNS, dropped connection): unknown.
    return { authenticated: false, unknown: true };
  }
}

/**
 * Sends the browser to the API to start a login. A full navigation, not a
 * fetch: the flow ends in a Keycloak redirect and a `Set-Cookie` on the way back.
 */
export function startBffLogin(returnTo: string, consentAttempt?: string): void {
  // `apiConfig.getUrl()` is '' when the API is served under the UI's origin, so
  // `url()` may be relative and needs `window.location.origin` as the base; the
  // base is ignored when the configured URL is absolute (local dev).
  const target = new URL(url('/api/v1/auth/session/login'), window.location.origin);
  target.searchParams.set('returnTo', returnTo);
  // The API may be on another origin (locally :2742 vs :3000), so it needs to be
  // told where to return. It checks this against its CORS allowlist.
  target.searchParams.set('appOrigin', window.location.origin);
  // Handed back on the callback redirect so a part-way consent survives the login.
  if (consentAttempt) target.searchParams.set('consentAttempt', consentAttempt);
  window.location.href = target.toString();
}

/**
 * Ends the server session, then hands off to Keycloak's end-session endpoint;
 * ending only the local session would leave SSO alive and sign the same user
 * straight back in. Returns whether the server ended the session, so the caller
 * can report a sign-out that did not take.
 */
export async function endBffSession(): Promise<boolean> {
  let endSessionUrl: string | null = null;
  let ended = false;
  try {
    const response = await fetch(url('/api/v1/auth/session/logout'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
    });
    if (response.ok) {
      ended = true;
      ({ endSessionUrl } = (await response.json()) as { endSessionUrl: string });
    }
  } catch {
    // Reported via the `false` return: the cookie, Redis session and SSO session
    // are still alive, and a reload would restore the previous user.
  }
  csrfToken = null;
  if (endSessionUrl) window.location.href = endSessionUrl;
  return ended;
}
