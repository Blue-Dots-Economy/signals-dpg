import { createHash, randomBytes } from 'node:crypto';
import { keycloakConfig } from '@/config';

/**
 * Server-side half of the OIDC authorization-code flow.
 *
 * The browser never sees a token: it is redirected to Keycloak, comes back with
 * a `code`, and this module exchanges the code for tokens kept in Redis
 * (`browser_session.ts`).
 *
 * PKCE is used with the public `signals-ui` client because the code verifier
 * never leaves the server: it is minted at login, held in Redis against the
 * `state`, and read back in the callback. The API callback is same-origin with
 * the UI, so it fits the redirect URIs that client already registers.
 *
 * Token requests go to `internal_base_url` (cluster-internal); browser URLs use
 * `base_url` (public issuer). The browser cannot resolve the internal name.
 */

export interface OidcTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch ms. */
  accessTokenExp: number;
  /** Epoch ms. */
  refreshTokenExp: number;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function newPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function newStateValue(): string {
  return randomBytes(32).toString('base64url');
}

function realmUrl(base: string): string {
  return `${base}/realms/${keycloakConfig.realm}/protocol/openid-connect`;
}

/** Where the browser is sent. Uses the public issuer, never the internal host. */
export function buildAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const url = new URL(`${realmUrl(keycloakConfig.base_url)}/auth`);
  url.searchParams.set('client_id', keycloakConfig.ui_client_id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Where the browser is sent to end the Keycloak session. */
export function buildEndSessionUrl(input: {
  idToken?: string;
  postLogoutRedirectUri: string;
}): string {
  const url = new URL(`${realmUrl(keycloakConfig.base_url)}/logout`);
  url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
  if (input.idToken) url.searchParams.set('id_token_hint', input.idToken);
  else url.searchParams.set('client_id', keycloakConfig.ui_client_id);
  return url.toString();
}

/**
 * Why Keycloak refused a grant, as `"<error> — <error_description>"`.
 *
 * Only the two OAuth error fields are read, never the whole body, because a
 * token-endpoint body can carry tokens. They distinguish a spent grant, an
 * issuer/host mismatch and a misconfigured client, which all return 400.
 *
 * Returns '' when the body is absent or not the OAuth error shape.
 */
async function oauthErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
    };
    const parts = [body.error, body.error_description].filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    );
    return parts.length > 0 ? `: ${parts.join(' — ')}` : '';
  } catch {
    return '';
  }
}

async function postToken(body: URLSearchParams): Promise<OidcTokens> {
  const endpoint = `${realmUrl(keycloakConfig.internal_base_url || keycloakConfig.base_url)}/token`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new OidcExchangeError(
      `token endpoint returned ${response.status}${await oauthErrorDetail(response)}`,
      response.status
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token) {
    throw new OidcExchangeError('token response missing access or refresh token');
  }

  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    accessTokenExp: now + (json.expires_in ?? 300) * 1000,
    // `||`, not `??`: Keycloak sends `refresh_expires_in: 0` when the refresh
    // token does not expire; keeping the 0 would floor the session's Redis TTL
    // at one second. Treat 0 as unspecified.
    refreshTokenExp: now + (json.refresh_expires_in || 1800) * 1000,
  };
}

/**
 * The `nonce` claim carried by an id token, or null when there is none.
 *
 * The token comes straight from Keycloak's token endpoint over TLS, so this
 * reads the claim without re-verifying the signature.
 */
export function idTokenNonce(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as { nonce?: unknown };
    return typeof claims.nonce === 'string' ? claims.nonce : null;
  } catch {
    return null;
  }
}

/**
 * A token-endpoint call that did not succeed. `status` lets the caller tell a
 * rejected grant (400/401: the session is over) from a 5xx or transport
 * failure (`status` undefined), where the session must survive the outage.
 */
export class OidcExchangeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }

  /** A verdict about the grant itself, rather than about Keycloak's health. */
  get isGrantRejected(): boolean {
    return this.status === 400 || this.status === 401;
  }
}

export async function exchangeCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<OidcTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: keycloakConfig.ui_client_id,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    })
  );
}

export async function refreshTokens(refreshToken: string): Promise<OidcTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: keycloakConfig.ui_client_id,
      refresh_token: refreshToken,
    })
  );
}
