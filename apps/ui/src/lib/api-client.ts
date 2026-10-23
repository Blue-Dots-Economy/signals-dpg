import axios from 'axios';

import { apiConfig } from './api-config';
import { emitSessionExpired } from './auth-events';
import { fetchBffSession, getCsrfToken } from './bff-session';

export function createApiClient() {
  const client = axios.create({
    baseURL: apiConfig.getUrl(),
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // No Authorization header: the session is an httpOnly cookie the browser
  // attaches (`withCredentials`). Cookies also go on cross-site requests, so
  // state-changing calls carry a CSRF token the API checks against the session.
  client.interceptors.request.use(async (config) => {
    const method = (config.method ?? 'get').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      let csrf = getCsrfToken();
      // React runs child effects before parent ones, so on a first login the
      // callback page's writes (e.g. the parked consent) can start before the
      // AuthProvider's `fetchBffSession()` has populated the token, and the
      // write would get a 403. Awaiting here closes that race. `fetchBffSession`
      // uses `fetch`, not this client, so there is no recursion.
      if (!csrf) {
        await fetchBffSession();
        csrf = getCsrfToken();
      }
      if (csrf) config.headers['x-csrf-token'] = csrf;
    }
    return config;
  });

  /**
   * Raises `emitSessionExpired()` on a 401 that means the session is gone, so
   * auth-context can end the client session. A session dying mid-use is
   * detected only here (`fetchSession` runs on mount only).
   *
   * `UNAUTHORIZED` alone also answers an anonymous caller, so it counts only
   * when `getCsrfToken() !== null` (this browser held a session; a 401 does not
   * clear it). The gate sits here, not in the handler, because the emit is
   * latched once per page and an anonymous 401 would spend the latch.
   * `TOKEN_EXPIRED` covers the Bearer-token path (resolve_session.ts), which has
   * no CSRF token. The API no longer emits `NO_ACTIVE_SESSION`.
   *
   * A 401 from a route the user may not call stays an ordinary error, and a 5xx
   * never qualifies: the API answers a dependency outage with 503 so it does not
   * read as a logout (see `bff-session.ts`'s `unknown`).
   */
  client.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
      // Optional chaining: throwing here on a malformed rejection would hide the real failure.
      const res = (error as { response?: { status?: number; data?: { code?: string } } } | undefined)
        ?.response;
      const code = res?.data?.code;
      const sessionIsGone =
        code === 'TOKEN_EXPIRED' ||
        code === 'NO_ACTIVE_SESSION' ||
        (code === 'UNAUTHORIZED' && getCsrfToken() !== null);
      if (res?.status === 401 && sessionIsGone) {
        emitSessionExpired();
      }
      return Promise.reject(error);
    },
  );

  return client;
}
