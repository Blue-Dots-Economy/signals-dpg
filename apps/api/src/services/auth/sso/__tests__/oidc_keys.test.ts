import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { createOidcKeys } from '../oidc_keys.js';

const pem = (curve: string) =>
  generateKeyPairSync('ec', { namedCurve: curve })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

describe('createOidcKeys', () => {
  it('signs an id_token that verifies against the published JWKS', async () => {
    const keys = createOidcKeys(pem('P-256'));
    const token = await keys.signIdToken({
      issuer: 'https://api.example.org/api/v1/auth/sso/oidc',
      audience: 'signals-sso',
      subject: 'ncs:u-1',
      ttlSeconds: 60,
      claims: { nonce: 'n-1', preferred_username: '+919730862967' },
    });

    const jwks = createLocalJWKSet(await keys.jwks());
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: 'https://api.example.org/api/v1/auth/sso/oidc',
      audience: 'signals-sso',
    });
    expect(protectedHeader.alg).toBe('ES256');
    expect(protectedHeader.kid).toBeTruthy();
    expect(payload.sub).toBe('ncs:u-1');
    expect(payload.nonce).toBe('n-1');
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it('publishes only the public half of the key', async () => {
    const { keys: [jwk] } = await createOidcKeys(pem('P-256')).jwks();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwk).not.toHaveProperty('d');
  });

  it('rejects a key that is not EC P-256', () => {
    expect(() => createOidcKeys(pem('secp384r1'))).toThrow(/P-256/);
  });

  it('rejects something that is not a private key', () => {
    expect(() => createOidcKeys('not a pem')).toThrow();
  });

  it('accepts a PEM whose line breaks arrived as literal \\n', async () => {
    const escaped = pem('P-256').trim().replaceAll('\n', '\\n');
    expect(escaped).not.toContain('\n');
    const keys = createOidcKeys(escaped);
    expect((await keys.jwks()).keys).toHaveLength(1);
  });

  it('rejects an unreadable key with a message naming the variable, not the key', () => {
    expect(() => createOidcKeys('-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----')).toThrow(
      /SSO_OIDC_SIGNING_KEY is not a readable private key/
    );
  });
});
