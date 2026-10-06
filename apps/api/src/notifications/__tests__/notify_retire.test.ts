import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotifyEvent, NotifyResult } from '@dpg/notification';

import type { RetireCancelledCounterparty } from '@/services/items/retire_connections';

const ACCEPTED: NotifyResult = {
  ok: true,
  status: 202,
  body: { notification_event_id: 'ne-1', correlation_id: 'c-1' },
};

const send = vi.fn(async (_event: NotifyEvent): Promise<NotifyResult> => ACCEPTED);
const resolveNotifierConfig = vi.fn();
const resolveOwnerEmail = vi.fn();

vi.mock('../notify_actions', () => ({
  resolveNotifierConfig: () => resolveNotifierConfig(),
}));
vi.mock('../resolve_owner', () => ({
  resolveOwnerEmail: (id: string) => resolveOwnerEmail(id),
}));

import { dispatchRetireCancelNotifications } from '../notify_retire';

const warn = vi.fn();
const log = { warn } as unknown as import('fastify').FastifyBaseLogger;

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
  send,
  teamName: 'EkStep',
  resolveCtaUrl: (domain: string) =>
    domain === 'seeker'
      ? 'https://seeker.example.org/auth/login'
      : 'https://provider.example.org/auth/login',
};

const sent = () => send.mock.calls.map(([event]) => event);

describe('dispatchRetireCancelNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveNotifierConfig.mockReturnValue(CONFIG);
    resolveOwnerEmail.mockResolvedValue('cp@example.com');
    send.mockResolvedValue(ACCEPTED);
  });

  it('sends one action.cancelled_by_retire event per counterparty', async () => {
    await dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2' })], log);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent()[0]).toEqual({
      event_type: 'action.cancelled_by_retire',
      domain: 'seeker',
      to: { email: 'cp@example.com' },
      variables: { ctaUrl: 'https://seeker.example.org/auth/login', teamName: 'EkStep' },
      priority: 'normal',
      idempotency_key: 'retire_cancel:a-1:usr-cp',
    });
  });

  it('carries teamName and never sends html, subject, template or channel', async () => {
    await dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2', domain: 'provider' })], log);
    for (const event of sent()) {
      expect(event.variables.teamName).toBe('EkStep');
      expect(Object.keys(event).sort()).toEqual(
        ['domain', 'event_type', 'idempotency_key', 'priority', 'to', 'variables'],
      );
    }
  });

  it('no-op when notifications are not configured', async () => {
    resolveNotifierConfig.mockReturnValue(null);
    await dispatchRetireCancelNotifications([cp()], log);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-op on empty counterparty list (never resolves config)', async () => {
    await dispatchRetireCancelNotifications([], log);
    expect(resolveNotifierConfig).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a counterparty with no owner user id (owner-less item)', async () => {
    await dispatchRetireCancelNotifications([cp({ ownerUserId: null })], log);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a counterparty with no local email (remote / phone-only) — local-only v1', async () => {
    resolveOwnerEmail.mockResolvedValue(null);
    await dispatchRetireCancelNotifications([cp()], log);
    expect(send).not.toHaveBeenCalled();
  });

  it('dedupes the same (action, owner) pair', async () => {
    await dispatchRetireCancelNotifications([cp(), cp()], log);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('logs a 422 from NS and continues with the next counterparty', async () => {
    send.mockResolvedValueOnce({ ok: false, status: 422, error: 'no_policy', kind: 'configuration' });
    await expect(
      dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2', ownerUserId: 'usr-2' })], log),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'action.cancelled_by_retire',
        status: 422,
        error: 'no_policy',
        kind: 'configuration',
        actionId: 'a-1',
      }),
      'ns_rejected',
    );
  });

  it('never throws when a send fails — logs and continues', async () => {
    send.mockRejectedValueOnce(new Error('ns down'));
    await expect(
      dispatchRetireCancelNotifications([cp(), cp({ actionId: 'a-2', ownerUserId: 'usr-2' })], log),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it('sends each cancelled counterparty to its own portal and domain', async () => {
    await dispatchRetireCancelNotifications(
      [
        cp({ actionId: 'a1', ownerUserId: 'u1', domain: 'seeker' }),
        cp({ actionId: 'a2', ownerUserId: 'u2', domain: 'provider' }),
      ],
      log,
    );

    const seeker = sent().find((s) => s.idempotency_key?.includes('u1'));
    const provider = sent().find((s) => s.idempotency_key?.includes('u2'));
    expect(seeker).toMatchObject({ domain: 'seeker', variables: { ctaUrl: 'https://seeker.example.org/auth/login' } });
    expect(provider).toMatchObject({ domain: 'provider', variables: { ctaUrl: 'https://provider.example.org/auth/login' } });
  });

  it('skips a counterparty whose domain resolves to no CTA url, but still sends the others (#569)', async () => {
    resolveNotifierConfig.mockReturnValue({
      ...CONFIG,
      resolveCtaUrl: (domain: string) =>
        domain === 'seeker' ? 'https://seeker.example.org/auth/login' : undefined,
    });

    await dispatchRetireCancelNotifications(
      [
        cp({ actionId: 'a-1', ownerUserId: 'u1', domain: 'seeker' }),
        cp({ actionId: 'a-2', ownerUserId: 'u2', domain: 'provider' }),
      ],
      log,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(sent()[0]).toMatchObject({
      idempotency_key: 'retire_cancel:a-1:u1',
      variables: { ctaUrl: 'https://seeker.example.org/auth/login' },
    });
  });
});
