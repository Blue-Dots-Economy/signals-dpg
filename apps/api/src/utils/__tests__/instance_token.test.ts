import { describe, it, expect, vi } from 'vitest';

// instance_token imports peerConfig from '@/config' at module load; mock it so
// we don't pull in loadEnv(). buildPeerHeaders uses this shared_secret.
vi.mock('@/config', () => ({
  peerConfig: {
    shared_secret: 'a'.repeat(48),
    auth_mode: 'permissive',
    token_window_seconds: 300,
  },
}));

import {
  signInstanceToken,
  verifyInstanceToken,
  buildPeerHeaders,
  INSTANCE_TOKEN_HEADER,
  INSTANCE_TIMESTAMP_HEADER,
} from '../instance_token.js';

const SECRET = 'b'.repeat(48);
const PATH = '/api/v1/network/item/count_local';
const BODY = '{"item_network":"blue_dot","item_domain":"student"}';

describe('instance_token — sign/verify (HMAC + body binding)', () => {
  it('round-trips: sign then verify with same path/body/secret/timestamp', () => {
    const { token, timestamp } = signInstanceToken({
      targetPath: PATH,
      body: BODY,
      secret: SECRET,
      nowSeconds: 1_000_000,
    });
    const result = verifyInstanceToken({
      targetPath: PATH,
      body: BODY,
      token,
      timestamp,
      secret: SECRET,
      nowSeconds: 1_000_000,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a tampered token', () => {
    const { token, timestamp } = signInstanceToken({ targetPath: PATH, body: BODY, secret: SECRET, nowSeconds: 1_000_000 });
    const flipped = (token[0] === '0' ? '1' : '0') + token.slice(1);
    expect(
      verifyInstanceToken({ targetPath: PATH, body: BODY, token: flipped, timestamp, secret: SECRET, nowSeconds: 1_000_000 })
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a mismatched target_path', () => {
    const { token, timestamp } = signInstanceToken({ targetPath: PATH, body: BODY, secret: SECRET, nowSeconds: 1_000_000 });
    expect(
      verifyInstanceToken({ targetPath: '/api/v1/network/item/fetch_local', body: BODY, token, timestamp, secret: SECRET, nowSeconds: 1_000_000 })
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a mismatched body (M2 — token is bound to the request body)', () => {
    const { token, timestamp } = signInstanceToken({ targetPath: PATH, body: BODY, secret: SECRET, nowSeconds: 1_000_000 });
    const tamperedBody = '{"item_network":"blue_dot","item_domain":"provider"}';
    expect(
      verifyInstanceToken({ targetPath: PATH, body: tamperedBody, token, timestamp, secret: SECRET, nowSeconds: 1_000_000 })
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects replay outside the window and accepts the boundary', () => {
    const { token } = signInstanceToken({ targetPath: PATH, body: BODY, secret: SECRET, nowSeconds: 1_000_000 });
    // signed at 1_000_000; now is 301s later → expired
    expect(
      verifyInstanceToken({ targetPath: PATH, body: BODY, token, timestamp: 1_000_000, secret: SECRET, nowSeconds: 1_000_301, windowSeconds: 300 })
    ).toEqual({ ok: false, reason: 'expired' });
    // exactly 300s later → still ok (boundary)
    expect(
      verifyInstanceToken({ targetPath: PATH, body: BODY, token, timestamp: 1_000_000, secret: SECRET, nowSeconds: 1_000_300, windowSeconds: 300 })
    ).toEqual({ ok: true });
  });

  it('rejects a future-dated token', () => {
    const { token } = signInstanceToken({ targetPath: PATH, body: BODY, secret: SECRET, nowSeconds: 1_000_301 });
    expect(
      verifyInstanceToken({ targetPath: PATH, body: BODY, token, timestamp: 1_000_301, secret: SECRET, nowSeconds: 1_000_000, windowSeconds: 300 })
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects missing token or timestamp', () => {
    expect(
      verifyInstanceToken({ targetPath: PATH, body: BODY, token: undefined, timestamp: undefined, secret: SECRET })
    ).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a malformed timestamp', () => {
    const { token } = signInstanceToken({ targetPath: PATH, body: BODY, secret: SECRET, nowSeconds: 1_000_000 });
    expect(
      verifyInstanceToken({ targetPath: PATH, body: BODY, token, timestamp: 'abc', secret: SECRET, nowSeconds: 1_000_000 })
    ).toEqual({ ok: false, reason: 'malformed_timestamp' });
  });

  it('buildPeerHeaders produces headers that verify against the shared secret', () => {
    const headers = buildPeerHeaders(PATH, BODY);
    expect(headers).toHaveProperty(INSTANCE_TOKEN_HEADER);
    expect(headers).toHaveProperty(INSTANCE_TIMESTAMP_HEADER);
    // shared_secret from the mocked peerConfig is used by both sign & verify.
    const result = verifyInstanceToken({
      targetPath: PATH,
      body: BODY,
      token: headers[INSTANCE_TOKEN_HEADER],
      timestamp: headers[INSTANCE_TIMESTAMP_HEADER],
    });
    expect(result).toEqual({ ok: true });
  });
});
