import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const claimPartnerToken = vi.fn(async (..._a: unknown[]) => true);
vi.mock('@/services/auth/sso/sso_store', () => ({
  claimPartnerToken: (...a: unknown[]) => claimPartnerToken(...a),
}));
vi.mock('@api/db/secondary/redis', () => ({ redis: {} }));
vi.mock('@dpg/config', () => ({
  allowed_origins: ['https://app.example.org'],
}));

const { createNcsProvider } = await import('../providers/ncs.js');

const SECRET = 'n'.repeat(64);
const NOW_S = 1_790_230_400;

const CLIENT_ID = 'bluedotsso-test';

async function link(opts: { iat?: number; exp?: number; secret?: string } = {}) {
  const iat = opts.iat ?? NOW_S - 10;
  const exp = opts.exp ?? iat + 600_000;
  const token = await new SignJWT({ role: 'JOBSEEKER', token_type: 'PARTNER_SSO' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('c88f0ddf-4a9f-4cd2-8592-4df23a800dc3')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
  return { token, clientId: CLIENT_ID, featureKey: 'placement-prep' };
}

const NCS_USER = {
  userId: '08093245-9ac4-457a-97d4-647824edc6db',
  fullName: 'Ameya Kulkarni',
  mobileNumber: '9730862967',
  role: 'JOBSEEKER',
  email: 'ameya@gmail.com',
  isEmailVerified: false,
  isMobileVerified: true,
  status: 'ACTIVE',
};

const validateToken = vi.fn();

function provider() {
  return createNcsProvider({
    clientId: CLIENT_ID,
    client: { validateToken },
    mapping: {
      item_type: 'profile_1.0',
      role_to_domain: {},
      fields: {},
      feature_routes: { 'placement-prep': '/discover', evil: 'https://evil.test' },
      app_origin: 'https://app.example.org',
    },
    nowSeconds: () => NOW_S,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  claimPartnerToken.mockResolvedValue(true);
  validateToken.mockResolvedValue({ ok: true, value: NCS_USER });
});

describe('NCS provider verify', () => {
  it('verifies a genuine link and returns the identity', async () => {
    const result = await provider().verify(await link());
    expect(result).toEqual({
      ok: true,
      value: {
        identity: {
          provider: 'ncs',
          providerUserId: NCS_USER.userId,
          subject: `ncs:${NCS_USER.userId}`,
          fullName: 'Ameya Kulkarni',
          phone: '+919730862967',
          phoneVerified: true,
          email: 'ameya@gmail.com',
          emailVerified: false,
          role: 'JOBSEEKER',
          attributes: NCS_USER,
        },
        returnTo: '/discover',
        appOrigin: 'https://app.example.org',
        claim: expect.any(Function),
      },
    });
  });

  it('calls NCS with the link token', async () => {
    const l = await link();
    await provider().verify(l);
    expect(validateToken).toHaveBeenCalledWith(l.token);
  });

  it('accepts a link without clientId or featureKey', async () => {
    const { token } = await link();
    expect(await provider().verify({ token })).toMatchObject({ ok: true, value: { returnTo: '/' } });
  });

  it.each([
    ['missing token', { token: undefined }],
    ['array token', { token: ['a', 'b'] }],
    ['oversized token', { token: 'x'.repeat(5000) }],
    ['another partner clientId', { clientId: 'someone-else' }],
    ['array clientId', { clientId: [CLIENT_ID, CLIENT_ID] }],
  ])('rejects %s without calling NCS', async (_label, override) => {
    const result = await provider().verify({ ...(await link()), ...override });
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
    expect(validateToken).not.toHaveBeenCalled();
  });

  it('does not check the signature — a JWT signed with a key we lack still goes to NCS', async () => {
    const l = await link({ secret: 'x'.repeat(64) });
    expect((await provider().verify(l)).ok).toBe(true);
    expect(validateToken).toHaveBeenCalledWith(l.token);
  });

  it('rejects a token that is not a JWT without calling NCS', async () => {
    const result = await provider().verify({ token: 'not-a-jwt' });
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
    expect(validateToken).not.toHaveBeenCalled();
  });

  it('rejects a JWT without exp or iat without calling NCS', async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(
      new TextEncoder().encode(SECRET)
    );
    const result = await provider().verify({ token });
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
    expect(validateToken).not.toHaveBeenCalled();
  });

  it('rejects an expired link as link-expired without calling NCS', async () => {
    const result = await provider().verify(await link({ iat: NOW_S - 400, exp: NOW_S - 100 }));
    expect(result).toMatchObject({ ok: false, reason: 'link-expired' });
    expect(validateToken).not.toHaveBeenCalled();
  });

  it('rejects a link issued in the future', async () => {
    const result = await provider().verify(await link({ iat: NOW_S + 120, exp: NOW_S + 420 }));
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
  });

  it('accepts a long-lived link — NCS owns the lifetime', async () => {
    const result = await provider().verify(await link({ exp: NOW_S + 7 * 24 * 3600 }));
    expect(result.ok).toBe(true);
  });

  it('passes NCS refusals through', async () => {
    validateToken.mockResolvedValue({ ok: false, reason: 'link-invalid' });
    expect(await provider().verify(await link())).toMatchObject({ reason: 'link-invalid' });
    validateToken.mockResolvedValue({ ok: false, reason: 'provider-unavailable' });
    expect(await provider().verify(await link())).toMatchObject({
      reason: 'provider-unavailable',
    });
  });

  it('does not claim the link itself — the caller claims it last', async () => {
    const result = await provider().verify(await link());
    expect(result.ok).toBe(true);
    expect(claimPartnerToken).not.toHaveBeenCalled();
  });

  it('claim() marks the token used until it expires, and reports a reuse', async () => {
    const l = await link();
    const result = await provider().verify(l);
    if (!result.ok) throw new Error('expected a verified link');

    expect(await result.value.claim()).toBe(true);
    expect(claimPartnerToken).toHaveBeenCalledWith('ncs', l.token, expect.any(Number));
    const ttl = claimPartnerToken.mock.calls[0]?.[2] as number;
    expect(ttl).toBeGreaterThanOrEqual(599_990);

    claimPartnerToken.mockResolvedValue(false);
    expect(await result.value.claim()).toBe(false);
  });

  it('refuses an inactive NCS account', async () => {
    validateToken.mockResolvedValue({ ok: true, value: { ...NCS_USER, status: 'BLOCKED' } });
    expect(await provider().verify(await link())).toMatchObject({ reason: 'account-inactive' });
  });

  it('fails closed when NCS returns no usable mobile', async () => {
    validateToken.mockResolvedValue({ ok: true, value: { ...NCS_USER, mobileNumber: null } });
    expect(await provider().verify(await link())).toMatchObject({ reason: 'link-invalid' });
    validateToken.mockResolvedValue({ ok: true, value: { ...NCS_USER, mobileNumber: '12' } });
    expect(await provider().verify(await link())).toMatchObject({ reason: 'link-invalid' });
  });

  it('lands unknown or off-origin feature keys on /', async () => {
    const unknown = await provider().verify({ ...(await link()), featureKey: 'nope' });
    expect(unknown).toMatchObject({ ok: true, value: { returnTo: '/' } });
    const evil = await provider().verify({ ...(await link()), featureKey: 'evil' });
    expect(evil).toMatchObject({ ok: true, value: { returnTo: '/' } });
  });
});
