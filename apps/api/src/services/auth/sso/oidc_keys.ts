import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, SignJWT, type JWK } from 'jose';

/**
 * The key the SSO API signs its id_tokens with, and the JWKS Keycloak reads
 * to verify them.
 *
 * ES256 (EC P-256): small signatures and a key that cannot be mistaken for
 * the HS256 partner secrets. The `kid` is the RFC 7638 thumbprint, so rotating
 * the key changes the `kid` and Keycloak refetches the JWKS on its own.
 *
 * Whoever holds this private key can log in as any SSO user, so it only ever
 * comes from the secret store (`SSO_OIDC_SIGNING_KEY`).
 */

const ALG = 'ES256';

export interface SignIdTokenInput {
  issuer: string;
  audience: string;
  subject: string;
  ttlSeconds: number;
  claims: Record<string, unknown>;
}

export interface OidcKeys {
  signIdToken(input: SignIdTokenInput): Promise<string>;
  jwks(): Promise<{ keys: JWK[] }>;
}

/**
 * Parse the configured private key. Accepts a PEM whose line breaks arrived as
 * literal `\n` (how a multi-line value usually survives an env var or a secret
 * store). Throws a message naming the variable, never the key material.
 */
function parsePrivateKey(raw: string): KeyObject {
  const pem = raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw;
  try {
    return createPrivateKey(pem.trim());
  } catch {
    throw new Error(
      'SSO_OIDC_SIGNING_KEY is not a readable private key (expected an EC P-256 PKCS#8 PEM).'
    );
  }
}

/**
 * Build the signing keys. Called once at boot when SSO is enabled
 * (`config.ts`), so a bad key stops the API from starting instead of failing
 * every SSO login later.
 */
export function createOidcKeys(privateKeyPem: string): OidcKeys {
  const privateKey: KeyObject = parsePrivateKey(privateKeyPem);
  if (
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('SSO_OIDC_SIGNING_KEY must be an EC P-256 private key (PKCS#8 PEM).');
  }

  const publicJwk: Promise<JWK> = (async () => {
    const jwk = await exportJWK(createPublicKey(privateKey));
    const kid = await calculateJwkThumbprint(jwk);
    return { ...jwk, kid, alg: ALG, use: 'sig' };
  })();

  return {
    async signIdToken(input) {
      const { kid } = await publicJwk;
      return new SignJWT(input.claims)
        .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
        .setIssuer(input.issuer)
        .setAudience(input.audience)
        .setSubject(input.subject)
        .setIssuedAt()
        .setExpirationTime(`${input.ttlSeconds}s`)
        .sign(privateKey);
    },
    async jwks() {
      return { keys: [await publicJwk] };
    },
  };
}
