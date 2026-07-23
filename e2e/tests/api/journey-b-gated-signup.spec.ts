import { test, expect } from '../../src/fixtures.js';
import { requireCapabilities } from '../../src/capabilities.js';
import { checkUser, requestOtp, login } from '../../src/auth.js';
import { newName, newPhone, newEmail } from '../../src/identities.js';

/**
 * Journey B — Gated instance blocks public self-signup (P0).
 * Runs only against a `gated` target. Guards: self-signup gate is server-enforced
 * and fail-closed · gating does not leak OTPs · the service-provisioning path works.
 */
test.describe('Journey B — gated self-signup', () => {
  test.skip(({ cfg }) => cfg.selfSignupMode !== 'gated', 'target is not gated (see Journey A)');

  test('auth config reports self-signup disabled', async ({ api }) => {
    const res = await api.get<{ selfSignupAllowed: boolean }>('/api/v1/auth/config');
    expect(res.status).toBe(200);
    expect(res.body.selfSignupAllowed, 'gated target must report selfSignupAllowed=false').toBeFalsy();
  });

  test('an unknown identifier cannot self-register (no OTP issued)', async ({ api, cfg }) => {
    const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
    const identity = channel === 'phone' ? { channel, value: newPhone() } as const : { channel, value: newEmail('b') } as const;

    const check = await checkUser(api, identity);
    expect(check.status).toBe(200);
    expect(check.body.userExists).toBeFalsy();

    // request-OTP for an unknown identifier must be rejected on a gated instance
    const req = await requestOtp(api, identity);
    expect([400, 403], `gated request-OTP should be rejected, got ${req.status} ${JSON.stringify(req.body)}`).toContain(req.status);
    // current contract: 403 SELF_SIGNUP_DISABLED
    if (req.status === 403) {
      expect((req.body as { code?: string }).code).toBe('SELF_SIGNUP_DISABLED');
    }
  });

  test('the service-provisioning path onboards a participant who can then log in', async ({ api, service, cfg, caps }) => {
    requireCapabilities(test, caps, ['serviceAuth', 'testOtp']);

    const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
    const identity = channel === 'phone' ? { channel, value: newPhone() } as const : { channel, value: newEmail('b') } as const;
    const idField = channel === 'phone' ? { phone_number: identity.value } : { email: identity.value };

    const prov = await service.post<{ user_id: string }>('/api/v1/admin/participant', {
      ...idField,
      name: newName('Provisioned'),
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      network: cfg.network,
    });
    expect(prov.status, `admin/participant: ${JSON.stringify(prov.body)}`).toBe(200);
    expect(prov.body.user_id).toBeTruthy();

    // the provisioned user now exists and can complete OTP login
    const check = await checkUser(api, identity);
    expect(check.body.userExists, 'provisioned user should exist').toBeTruthy();

    const session = await login(api, identity);
    expect(session.token, 'provisioned participant can log in').toBeTruthy();
  });
});
