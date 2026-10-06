import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotifyEvent, NotifyResult } from '@dpg/notification';

// Mock the dispatcher's external deps so we exercise its own logic (config gate,
// owner lookup, event selection, variable build, send call) in isolation.
const { send, resolveNotifierConfig, resolveNetworkBrandName, resolveOwnerNameEmail } =
  vi.hoisted(() => ({
    send: vi.fn(),
    resolveNotifierConfig: vi.fn(),
    resolveNetworkBrandName: vi.fn(),
    resolveOwnerNameEmail: vi.fn(),
  }));

vi.mock('../notify_actions', () => ({
  resolveNotifierConfig: () => resolveNotifierConfig(),
  resolveNetworkBrandName: (n: string) => resolveNetworkBrandName(n),
}));
vi.mock('../resolve_owner', () => ({
  resolveOwnerNameEmail: (id: string) => resolveOwnerNameEmail(id),
}));

import type { FastifyBaseLogger } from 'fastify';

import { dispatchItemLifecycleNotification } from '../notify_item_lifecycle';

const ACCEPTED: NotifyResult = {
  ok: true,
  status: 202,
  body: { notification_event_id: 'ne-1', correlation_id: 'c-1' },
};

const warn = vi.fn();
const info = vi.fn();
const log = { warn, info, error: vi.fn() } as unknown as FastifyBaseLogger;

function configured() {
  resolveNotifierConfig.mockReturnValue({
    send,
    teamName: 'EkStep',
    // Per-recipient (#569): a split deployment serves each domain from its own
    // host, and the item owner's domain is what picks the portal. Any domain
    // maps to its own host, except the sentinel `unmapped` used by the skip test.
    resolveCtaUrl: (domain: string) =>
      domain === 'unmapped' ? undefined : `https://${domain}.example.org/auth/login`,
  });
}

const sentEvent = (): NotifyEvent => send.mock.calls[0]![0] as NotifyEvent;

describe('dispatchItemLifecycleNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockResolvedValue(ACCEPTED);
    resolveNetworkBrandName.mockResolvedValue('Blue Dot');
  });

  it('no-ops when notifications are not configured', async () => {
    resolveNotifierConfig.mockReturnValue(null);
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(send).not.toHaveBeenCalled();
    expect(resolveOwnerNameEmail).not.toHaveBeenCalled();
  });

  it('no-ops for a phone-only owner (no email)', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: null });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('sends item.created for a self seeker create with the owner name', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentEvent()).toEqual({
      event_type: 'item.created',
      domain: 'seeker',
      to: { email: 'a@x.com' },
      variables: {
        name: 'Asha',
        ctaUrl: 'https://seeker.example.org/auth/login',
        teamName: 'EkStep',
      },
      priority: 'normal',
      // No itemId on this event → the key omits the item segment.
      idempotency_key: 'item_lifecycle:item.created:u1',
    });
  });

  it('sends item.created_draft for a draft create', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', itemId: 'item-9', domain: 'seeker', network: 'blue_dot', lifecycleStatus: 'draft' },
      log,
    );
    expect(sentEvent()).toMatchObject({
      event_type: 'item.created_draft',
      domain: 'seeker',
      variables: { name: 'Asha', teamName: 'EkStep' },
    });
  });

  it('passes a per-(event,owner,item) idempotency key so NS does not drop it (#592 Blocker 1)', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', itemId: 'item-9', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(sentEvent().idempotency_key).toBe('item_lifecycle:item.created:u1:item-9');
  });

  it('sends item.updated with the real domain for a service_provider update', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Acme', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'update', ownerId: 'u1', domain: 'service_provider', network: 'purple_dot' },
      log,
    );
    expect(sentEvent()).toMatchObject({ event_type: 'item.updated', domain: 'service_provider' });
  });

  it('sends item.onboarded_by_aggregator with the org name for an aggregator create', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      {
        op: 'create',
        ownerId: 'u1',
        domain: 'seeker',
        network: 'blue_dot',
        actingOrgType: 'aggregator',
        aggregatorOrgName: 'SkillBridge Network',
      },
      log,
    );
    expect(resolveNetworkBrandName).toHaveBeenCalledWith('blue_dot');
    expect(sentEvent()).toEqual({
      event_type: 'item.onboarded_by_aggregator',
      domain: 'seeker',
      to: { email: 'a@x.com' },
      variables: {
        aggregatorOrg: 'SkillBridge Network',
        networkName: 'Blue Dot',
        ctaUrl: 'https://seeker.example.org/auth/login',
        teamName: 'EkStep',
      },
      priority: 'normal',
      idempotency_key: 'item_lifecycle:item.onboarded_by_aggregator:u1',
    });
  });

  it('falls back to the brand name when the aggregator org name is missing', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot', actingOrgType: 'aggregator' },
      log,
    );
    expect(sentEvent().variables).toMatchObject({ aggregatorOrg: 'Blue Dot' });
  });

  it('greets a nameless owner as "there"', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: null, email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'retire', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(sentEvent()).toMatchObject({ event_type: 'item.retired' });
    expect(sentEvent().variables.name).toBe('there');
  });

  it('carries teamName on every item event and never sends html, subject, template or channel', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    for (const op of ['create', 'update', 'pause', 'retire'] as const) {
      await dispatchItemLifecycleNotification({ op, ownerId: 'u1', domain: 'seeker', network: 'blue_dot' }, log);
    }
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot', actingOrgType: 'aggregator' },
      log,
    );
    expect(send).toHaveBeenCalledTimes(5);
    for (const [event] of send.mock.calls as [NotifyEvent][]) {
      expect(event.variables.teamName).toBe('EkStep');
      expect(Object.keys(event).sort()).toEqual(
        ['domain', 'event_type', 'idempotency_key', 'priority', 'to', 'variables'],
      );
    }
  });

  it('logs a 422 from NS as ns_rejected and swallows it (best effort)', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    send.mockResolvedValue({ ok: false, status: 422, error: 'missing_variable', kind: 'caller' });
    await expect(
      dispatchItemLifecycleNotification(
        { op: 'update', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      {
        event_type: 'item.updated',
        status: 422,
        error: 'missing_variable',
        kind: 'caller',
        op: 'update',
        network: 'blue_dot',
        ownerId: 'u1',
      },
      'ns_rejected',
    );
  });

  it('never throws — swallows a dependency error and logs', async () => {
    configured();
    resolveOwnerNameEmail.mockRejectedValue(new Error('db down'));
    await expect(
      dispatchItemLifecycleNotification(
        { op: 'pause', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('links a provider-owned item to the provider portal, not the seeker one (#569)', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });

    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'provider', network: 'blue_dot' },
      log,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(sentEvent().variables.ctaUrl).toBe('https://provider.example.org/auth/login');
  });

  it('skips the send when the domain resolves to no URL rather than shipping a dead link', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });

    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'unmapped', network: 'blue_dot' },
      log,
    );

    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
