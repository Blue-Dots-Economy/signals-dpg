import { describe, it, expect, vi, beforeEach } from 'vitest';

const { client } = vi.hoisted(() => ({ client: { current: undefined as unknown } }));

vi.mock('@/utils/notificationClient', () => ({ getNotificationClient: () => client.current }));
vi.mock('@/config', () => ({ instance: { INSTANCE_ENV: 'production' } }));
vi.mock('../../email/dispatch_email', () => ({ getInstanceDefaultNetwork: () => 'purple_dot' }));
vi.mock('../templates', () => ({ getSmsTemplates: async () => new Map() }));

import { getDefaultSmsSender, resetDefaultSmsSenderForTests, smsLink } from '../default_sms_sender';

describe('getDefaultSmsSender', () => {
  beforeEach(() => resetDefaultSmsSenderForTests());

  it('is null when no notification client is configured', () => {
    client.current = undefined;
    expect(getDefaultSmsSender()).toBeNull();
  });

  it('builds one sender and reuses it', () => {
    client.current = { notify: vi.fn() };
    const sender = getDefaultSmsSender();
    expect(sender).not.toBeNull();
    expect(getDefaultSmsSender()).toBe(sender);
  });
});

describe('smsLink', () => {
  it('reduces an app link to its origin', () => {
    expect(smsLink('https://seekers-purpledots.depwd.gov.in/auth/login')).toBe('https://seekers-purpledots.depwd.gov.in');
  });

  it('is null for a missing or unparseable link', () => {
    expect(smsLink(undefined)).toBeNull();
    expect(smsLink('')).toBeNull();
    expect(smsLink('not a url')).toBeNull();
  });
});
