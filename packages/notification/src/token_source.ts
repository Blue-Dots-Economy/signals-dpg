/**
 * OAuth2 `client_credentials` access tokens, cached until shortly before they
 * expire.
 *
 * One implementation for every service-account caller in Signals: the
 * notification client and the Keycloak Admin client both build one of these.
 */

export interface TokenSource {
  /** A valid access token, fetched or served from the cache. */
  token(): Promise<string>;
  /** Drop the cached token, so the next `token()` fetches a fresh one. */
  invalidate(): void;
}

export interface ClientCredentialsTokenSourceConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout for the token call. Defaults to 10 s. */
  timeoutMs?: number;
  /** Clock in epoch ms. Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * The token endpoint refused the request or answered without a token. The
 * message names the HTTP status only; the response body is never included, so
 * a token or secret echoed back by a misconfigured proxy cannot leak.
 */
export class TokenSourceError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'TokenSourceError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Refresh this long before the token's stated expiry. */
const EXPIRY_MARGIN_S = 30;
/** Never cache a token for less than this, whatever `expires_in` says. */
const MIN_CACHE_S = 10;
/** Assumed lifetime when the endpoint omits `expires_in`. */
const DEFAULT_EXPIRES_IN_S = 60;

export function createClientCredentialsTokenSource(
  cfg: ClientCredentialsTokenSourceConfig
): TokenSource {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = cfg.now ?? Date.now;

  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;
  // Bumped by invalidate(), so a fetch that started before it cannot repopulate
  // the cache with a token the caller has just declared stale.
  let generation = 0;

  async function fetchToken(startedAt: number, gen: number): Promise<string> {
    const res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // Drain without reading into memory we keep; the body is never surfaced.
      await res.body?.cancel().catch(() => undefined);
      throw new TokenSourceError(
        `token endpoint answered ${res.status}`,
        res.status
      );
    }

    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new TokenSourceError(
        `token endpoint answered ${res.status} without an access_token`,
        res.status
      );
    }

    const expiresIn =
      typeof body.expires_in === 'number' ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    const lifetimeS = Math.max(expiresIn - EXPIRY_MARGIN_S, MIN_CACHE_S);
    if (gen === generation) {
      cached = { token: body.access_token, expiresAt: startedAt + lifetimeS * 1000 };
    }
    return body.access_token;
  }

  return {
    // Deliberately not `async`: the clock is read and the cache checked
    // synchronously, so a caller that pins the clock for one call (see
    // KeycloakAdminClient.accessToken) sees its own value used.
    token(): Promise<string> {
      const at = now();
      if (cached && at < cached.expiresAt) return Promise.resolve(cached.token);
      if (inFlight) return inFlight;

      const gen = generation;
      const pending = fetchToken(at, gen).finally(() => {
        if (inFlight === pending) inFlight = null;
      });
      inFlight = pending;
      return pending;
    },

    invalidate(): void {
      cached = null;
      inFlight = null;
      generation += 1;
    },
  };
}
