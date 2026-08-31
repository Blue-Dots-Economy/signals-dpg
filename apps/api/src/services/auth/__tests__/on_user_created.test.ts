import { describe, it, expect, vi, beforeEach } from 'vitest';

const { materializeSignupGuardian, sendWelcomeNotifications, resolveSignupDomain } = vi.hoisted(
  () => ({
    materializeSignupGuardian: vi.fn(async () => {}),
    sendWelcomeNotifications: vi.fn(async () => {}),
    resolveSignupDomain: vi.fn(async () => null as string | null),
  }),
);

vi.mock('@/services/signup_guardian', () => ({ materializeSignupGuardian }));
vi.mock('@/notifications/welcome', () => ({ sendWelcomeNotifications }));
vi.mock('@/notifications/resolve_signup_domain', () => ({ resolveSignupDomain }));

const { runAfterUserCreate } = await import('../on_user_created.js');

const USER = { id: 'u1', name: 'Asha', email: 'a@x.com', phoneNumber: '+911234567890' };

beforeEach(() => {
  materializeSignupGuardian.mockClear().mockImplementation(async () => {});
  sendWelcomeNotifications.mockClear().mockImplementation(async () => {});
  resolveSignupDomain.mockClear().mockResolvedValue(null);
});

describe('runAfterUserCreate', () => {
  it('materializes the guardian and sends the welcome with the resolved domain', async () => {
    resolveSignupDomain.mockResolvedValue('provider');
    await runAfterUserCreate(USER);

    expect(materializeSignupGuardian).toHaveBeenCalledWith(USER);
    expect(resolveSignupDomain).toHaveBeenCalledWith({
      email: 'a@x.com',
      phoneNumber: '+911234567890',
    });
    expect(sendWelcomeNotifications).toHaveBeenCalledWith(
      { name: 'Asha', email: 'a@x.com', phoneNumber: '+911234567890' },
      expect.objectContaining({ error: expect.any(Function) }),
      'provider',
    );
  });

  it('passes a null domain through to the generic welcome', async () => {
    resolveSignupDomain.mockResolvedValue(null);
    await runAfterUserCreate(USER);
    const call = sendWelcomeNotifications.mock.calls[0] as unknown[];
    expect(call[2]).toBeNull();
  });

  it('still sends the welcome when guardian materialisation throws', async () => {
    materializeSignupGuardian.mockRejectedValueOnce(new Error('boom'));
    await expect(runAfterUserCreate(USER)).resolves.toBeUndefined();
    expect(sendWelcomeNotifications).toHaveBeenCalledTimes(1);
  });
});
