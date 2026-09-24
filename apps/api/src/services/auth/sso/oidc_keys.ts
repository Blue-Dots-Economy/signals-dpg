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

export function createOidcKeys(privateKeyPem: string): OidcKeys {
  const privateKey: KeyObject = createPrivateKey(privateKeyPem);
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
