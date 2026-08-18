import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { RetireCancelledCounterparty } from '@/services/items/retire_connections';

const dispatchEmail = vi.fn(async (_args: unknown) => ({ ok: true }));
const resolveNotifierConfig = vi.fn();
const resolveNetworkBrandName = vi.fn(async (_n: string) => 'Blue Dot');
const resolveOwnerEmail = vi.fn();

vi.mock('../notify_actions', () => ({
  resolveNotifierConfig: () => resolveNotifierConfig(),
  resolveNetworkBrandName: (n: string) => resolveNetworkBrandName(n),
}));
vi.mock('../resolve_owner', () => ({
  resolveOwnerEmail: (id: string) => resolveOwnerEmail(id),
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
  sender: { dispatchEmail },
  ctaUrl: 'https://app/login',
};

describe('dispatchRetireCancelNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveNotifierConfig.mockReturnValue(CONFIG);
    resolveOwnerEmail.mockResolvedValue('cp@example.com');
    dispatchEmail.mockResolvedValue({ ok: true });
  });

  it('sends one retire-cancel email per counterparty', async () => {
    await dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2' })], 'blue_dot', log);
    expect(dispatchEmail).toHaveBeenCalledTimes(2);
    const req = dispatchEmail.mock.calls[0][0] as {
      caseId: string;
      to: string;
      dedupeId: string;
    };
    expect(req.caseId).toBe('retire.cancel');
    expect(req.to).toBe('cp@example.com');
    expect(req.dedupeId).toBe('retire_cancel:a-1:usr-cp');
  });

  it('no-op when notifications are not configured', async () => {
    resolveNotifierConfig.mockReturnValue(null);
    await dispatchRetireCancelNotifications([cp()], 'blue_dot', log);
    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it('no-op on empty counterparty list (never resolves config)', async () => {
    await dispatchRetireCancelNotifications([], 'blue_dot', log);
    expect(resolveNotifierConfig).not.toHaveBeenCalled();
    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it('skips a counterparty with no owner user id (owner-less item)', async () => {
    await dispatchRetireCancelNotifications([cp({ ownerUserId: null })], 'blue_dot', log);
    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it('skips a counterparty with no local email (remote / phone-only) — local-only v1', async () => {
    resolveOwnerEmail.mockResolvedValue(null);
    await dispatchRetireCancelNotifications([cp()], 'blue_dot', log);
    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it('dedupes the same (action, owner) pair', async () => {
    await dispatchRetireCancelNotifications([cp(), cp()], 'blue_dot', log);
    expect(dispatchEmail).toHaveBeenCalledTimes(1);
  });

  it('never throws when a send fails — logs and continues', async () => {
    dispatchEmail.mockRejectedValueOnce(new Error('ns down'));
    await expect(
      dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2', ownerUserId: 'usr-2' })], 'blue_dot', log),
    ).resolves.toBeUndefined();
    expect(dispatchEmail).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });
});
