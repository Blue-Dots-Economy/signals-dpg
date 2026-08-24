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
  resolveCtaUrl: (domain: string) =>
    domain === 'seeker'
      ? 'https://seeker.example.org/auth/login'
      : 'https://provider.example.org/auth/login',
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

  it('sends each cancelled counterparty to its own portal', async () => {
    // Two counterparties in different domains on one retire.
    const counterparties = [
      { actionId: 'a1', actionType: 'connect', ownerUserId: 'u1', itemId: 'i1', domain: 'seeker', network: 'blue_dot' },
      { actionId: 'a2', actionType: 'connect', ownerUserId: 'u2', itemId: 'i2', domain: 'provider', network: 'blue_dot' },
    ];

    await dispatchRetireCancelNotifications(counterparties, 'blue_dot', log);

    const sent = dispatchEmail.mock.calls.map(
      ([args]) => args as { dedupeId?: string; ctaUrl?: string },
    );
    const seeker = sent.find((s) => s.dedupeId?.includes('u1'));
    const provider = sent.find((s) => s.dedupeId?.includes('u2'));
    expect(seeker?.ctaUrl).toBe('https://seeker.example.org/auth/login');
    expect(provider?.ctaUrl).toBe('https://provider.example.org/auth/login');
  });

  it('skips a counterparty whose domain resolves to no CTA url, but still sends the others (#569)', async () => {
    // `dispatch_email` renders `args.ctaUrl ?? ''` into the shell, so an
    // unresolved URL ships a dead `<a href="">`. The guard must skip only the
    // affected counterparty, not abort the whole retire-cancel loop.
    resolveNotifierConfig.mockReturnValue({
      sender: { dispatchEmail },
      resolveCtaUrl: (domain: string) =>
        domain === 'seeker' ? 'https://seeker.example.org/auth/login' : undefined,
    });

    await dispatchRetireCancelNotifications(
      [
        cp({ actionId: 'a-1', ownerUserId: 'u1', domain: 'seeker' }),
        cp({ actionId: 'a-2', ownerUserId: 'u2', domain: 'provider' }),
      ],
      'blue_dot',
      log,
    );

    // Only the resolvable (seeker) counterparty is sent.
    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    const req = dispatchEmail.mock.calls[0][0] as { dedupeId?: string; ctaUrl?: string };
    expect(req.dedupeId).toBe('retire_cancel:a-1:u1');
    expect(req.ctaUrl).toBe('https://seeker.example.org/auth/login');
  });
});
