import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { RetireCancelledCounterparty } from '@/services/items/retire_connections';

const notify = vi.fn(async (_req: unknown) => undefined);
const resolveNotifierConfig = vi.fn();
const resolveNetworkBrandName = vi.fn(async (_n: string) => 'Blue Dot');
const resolveOwnerEmail = vi.fn();
const renderRetireCancelEmail = vi.fn((_i: unknown) => ({ subject: 'Subj', html: '<p>body</p>' }));

vi.mock('../notify_actions', () => ({
  resolveNotifierConfig: () => resolveNotifierConfig(),
  resolveNetworkBrandName: (n: string) => resolveNetworkBrandName(n),
}));
vi.mock('../resolve_owner', () => ({
  resolveOwnerEmail: (id: string) => resolveOwnerEmail(id),
}));
vi.mock('../render_action_email', () => ({
  renderRetireCancelEmail: (i: unknown) => renderRetireCancelEmail(i),
}));

import { dispatchRetireCancelNotifications } from '../notify_retire';

const log = { warn: vi.fn() } as unknown as import('fastify').FastifyBaseLogger;

const cp = (o: Partial<RetireCancelledCounterparty> = {}): RetireCancelledCounterparty => ({
  actionId: 'a-1',
  actionType: 'connect',
  ownerUserId: 'usr-cp',
  itemId: 'item-2',
  domain: 'seeker',
  network: 'blue_dot',
  ...o,
});

const CONFIG = {
  notify,
  fromEmail: 'from@x.io',
  replyTo: 'reply@x.io',
  ctaUrl: 'https://app/login',
};

describe('dispatchRetireCancelNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveNotifierConfig.mockReturnValue(CONFIG);
    resolveOwnerEmail.mockResolvedValue('cp@example.com');
  });

  it('sends one retire-cancel email per counterparty', async () => {
    await dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2' })], 'blue_dot', log);
    expect(notify).toHaveBeenCalledTimes(2);
    const req = notify.mock.calls[0][0] as { to: string; dedupe_id: string; variables: { subject: string } };
    expect(req.to).toBe('cp@example.com');
    expect(req.dedupe_id).toBe('retire_cancel:a-1:usr-cp');
    expect(req.variables.subject).toBe('Subj');
  });

  it('no-op when notifications are not configured', async () => {
    resolveNotifierConfig.mockReturnValue(null);
    await dispatchRetireCancelNotifications([cp()], 'blue_dot', log);
    expect(notify).not.toHaveBeenCalled();
  });

  it('no-op on empty counterparty list (never resolves config)', async () => {
    await dispatchRetireCancelNotifications([], 'blue_dot', log);
    expect(resolveNotifierConfig).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips a counterparty with no owner user id (owner-less item)', async () => {
    await dispatchRetireCancelNotifications([cp({ ownerUserId: null })], 'blue_dot', log);
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips a counterparty with no local email (remote / phone-only) — local-only v1', async () => {
    resolveOwnerEmail.mockResolvedValue(null);
    await dispatchRetireCancelNotifications([cp()], 'blue_dot', log);
    expect(notify).not.toHaveBeenCalled();
  });

  it('dedupes the same (action, owner) pair', async () => {
    await dispatchRetireCancelNotifications([cp(), cp()], 'blue_dot', log);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('never throws when a send fails — logs and continues', async () => {
    notify.mockRejectedValueOnce(new Error('ns down'));
    await expect(
      dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2', ownerUserId: 'usr-2' })], 'blue_dot', log),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });
});
