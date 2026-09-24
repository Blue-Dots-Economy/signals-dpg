import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createNcsClient } from '../ncs_client.js';

const CONFIG = {
  baseUrl: 'https://ncs.example.gov.in',
  clientId: 'bluedots-abc',
  clientSecret: 's'.repeat(64),
  timeoutMs: 1000,
};

const USER = {
  userId: '08093245-9ac4-457a-97d4-647824edc6db',
  fullName: 'Ameya Kulkarni',
  mobileNumber: '9730862967',
  role: 'JOBSEEKER',
  isEmailVerified: false,
  email: 'ameya@gmail.com',
  isMobileVerified: true,
  status: 'ACTIVE',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ncs validateToken', () => {
  it('posts token + HMAC(secret, token) + clientId and returns the user', async () => {
    const fetchMock = vi.fn(async () =>
      json({ status: 'SUCCESS', statusCode: 200, data: USER })
    );
    const client = createNcsClient(CONFIG, fetchMock as unknown as typeof fetch);

    const result = await client.validateToken('jwt.token.value');

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ userId: USER.userId }) });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ncs.example.gov.in/api/integration/validate-token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      token: 'jwt.token.value',
      hmac: createHmac('sha256', CONFIG.clientSecret).update('jwt.token.value').digest('hex'),
      clientId: 'bluedots-abc',
    });
  });

  it('maps a FAILURE body to link-invalid', async () => {
    const client = createNcsClient(
      CONFIG,
      (async () =>
        json({ status: 'FAILURE', statusCode: 401, message: 'Invalid HMAC', data: null }, 401)) as unknown as typeof fetch
    );
    expect(await client.validateToken('t')).toMatchObject({ ok: false, reason: 'link-invalid' });
  });

  it('maps a 5xx or network error to provider-unavailable', async () => {
    const down = createNcsClient(CONFIG, (async () => json({}, 503)) as unknown as typeof fetch);
    expect(await down.validateToken('t')).toMatchObject({ ok: false, reason: 'provider-unavailable' });

    const broken = createNcsClient(CONFIG, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    expect(await broken.validateToken('t')).toMatchObject({
      ok: false,
      reason: 'provider-unavailable',
    });
  });

  it('treats a SUCCESS body with an unexpected shape as provider-unavailable', async () => {
    const client = createNcsClient(
      CONFIG,
      (async () => json({ status: 'SUCCESS', data: { nope: true } })) as unknown as typeof fetch
    );
    expect(await client.validateToken('t')).toMatchObject({
      ok: false,
      reason: 'provider-unavailable',
    });
  });

  it('stops calling NCS while the circuit is open', async () => {
    const fetchMock = vi.fn(async () => json({}, 503));
    const client = createNcsClient(
      { ...CONFIG, failureThreshold: 2, openMs: 60_000 },
      fetchMock as unknown as typeof fetch
    );
    await client.validateToken('t');
    await client.validateToken('t');
    await client.validateToken('t');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
