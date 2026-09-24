import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
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

function cryptoJsEncrypt(text: string, passphrase: string): string {
  const salt = randomBytes(8);
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = createHash('md5')
      .update(Buffer.concat([block, Buffer.from(passphrase), salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  const c = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  return Buffer.concat([
    Buffer.from('Salted__'),
    salt,
    c.update(text, 'utf8'),
    c.final(),
  ]).toString('base64');
}

async function link(opts: { iat?: number; exp?: number; secret?: string } = {}) {
  const iat = opts.iat ?? NOW_S - 10;
  const exp = opts.exp ?? iat + 300;
  const userName = await new SignJWT({ userName: 'dge-mole_ameya@gmail.com' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
  return {
    userName,
    sig: cryptoJsEncrypt(`dge-mole_ameya@gmail.com`, SECRET),
    expiry: `${exp}.288`,
    featureKey: 'placement-prep',
  };
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
    clientSecret: SECRET,
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
      },
    });
  });

  it('calls NCS with the userName JWT as the token', async () => {
    const l = await link();
    await provider().verify(l);
    expect(validateToken).toHaveBeenCalledWith(l.userName);
  });

  it.each([
    ['missing userName', { userName: undefined }],
    ['missing sig', { sig: undefined }],
    ['missing expiry', { expiry: undefined }],
    ['array param', { userName: ['a', 'b'] }],
    ['oversized param', { sig: 'x'.repeat(5000) }],
  ])('rejects %s without calling NCS', async (_label, override) => {
    const result = await provider().verify({ ...(await link()), ...override });
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
    expect(validateToken).not.toHaveBeenCalled();
  });

  it('rejects a JWT signed with another secret', async () => {
    const result = await provider().verify(await link({ secret: 'x'.repeat(64) }));
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
    expect(validateToken).not.toHaveBeenCalled();
  });

  it('rejects an expired link as link-expired', async () => {
    const result = await provider().verify(await link({ iat: NOW_S - 400, exp: NOW_S - 100 }));
    expect(result).toMatchObject({ ok: false, reason: 'link-expired' });
  });

  it('rejects a link issued in the future', async () => {
    const result = await provider().verify(await link({ iat: NOW_S + 120, exp: NOW_S + 420 }));
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
  });

  it('rejects a link valid for longer than the maximum lifetime', async () => {
    const result = await provider().verify(await link({ iat: NOW_S - 10, exp: NOW_S + 3600 }));
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
  });

  it('rejects a sig that does not decrypt with the secret', async () => {
    const l = await link();
    const result = await provider().verify({ ...l, sig: cryptoJsEncrypt('x', 'other') });
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
    expect(validateToken).not.toHaveBeenCalled();
  });

  it('rejects an expiry that disagrees with the JWT', async () => {
    const l = await link();
    const result = await provider().verify({ ...l, expiry: '1' });
    expect(result).toMatchObject({ ok: false, reason: 'link-invalid' });
  });

  it('passes NCS refusals through', async () => {
    validateToken.mockResolvedValue({ ok: false, reason: 'link-invalid' });
    expect(await provider().verify(await link())).toMatchObject({ reason: 'link-invalid' });
    validateToken.mockResolvedValue({ ok: false, reason: 'provider-unavailable' });
    expect(await provider().verify(await link())).toMatchObject({
      reason: 'provider-unavailable',
    });
  });

  it('refuses a link already used', async () => {
    claimPartnerToken.mockResolvedValue(false);
    expect(await provider().verify(await link())).toMatchObject({ reason: 'link-reused' });
  });

  it('claims the token only after NCS confirms it, until it expires', async () => {
    validateToken.mockResolvedValue({ ok: false, reason: 'provider-unavailable' });
    await provider().verify(await link());
    expect(claimPartnerToken).not.toHaveBeenCalled();

    validateToken.mockResolvedValue({ ok: true, value: NCS_USER });
    const l = await link();
    await provider().verify(l);
    expect(claimPartnerToken).toHaveBeenCalledWith('ncs', l.userName, expect.any(Number));
    const ttl = claimPartnerToken.mock.calls[0]?.[2] as number;
    expect(ttl).toBeGreaterThanOrEqual(290);
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
