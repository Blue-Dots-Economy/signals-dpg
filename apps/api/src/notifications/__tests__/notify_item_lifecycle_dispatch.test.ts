import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dispatcher's external deps so we exercise its own logic (config gate,
// owner lookup, case selection, variable build, dispatchEmail call) in isolation.
const { dispatchEmail, resolveNotifierConfig, resolveNetworkBrandName, resolveOwnerNameEmail } =
  vi.hoisted(() => ({
    dispatchEmail: vi.fn().mockResolvedValue({ ok: true }),
    resolveNotifierConfig: vi.fn(),
    resolveNetworkBrandName: vi.fn().mockResolvedValue('Blue Dot'),
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

const warn = vi.fn();
const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function configured() {
  resolveNotifierConfig.mockReturnValue({
    sender: { dispatchEmail },
    // Per-recipient now (#569): a split deployment serves each domain from its
    // own host, and the item owner's domain is what picks the portal.
    // Any domain maps to its own host, except the sentinel `unmapped` used by
    // the skip test — so this cannot accidentally mask an unrelated domain.
    resolveCtaUrl: (domain: string) =>
      domain === 'unmapped' ? undefined : `https://${domain}.example.org/auth/login`,
  });
}

describe('dispatchItemLifecycleNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveNetworkBrandName.mockResolvedValue('Blue Dot');
  });

  it('no-ops when notifications are not configured', async () => {
    resolveNotifierConfig.mockReturnValue(null);
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(dispatchEmail).not.toHaveBeenCalled();
    expect(resolveOwnerNameEmail).not.toHaveBeenCalled();
  });

  it('no-ops for a phone-only owner (no email)', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true,name: 'Asha', email: null });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it('sends profile.create for a self seeker create with the owner name', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true,name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    expect(dispatchEmail).toHaveBeenCalledWith({
      caseId: 'profile.create',
      to: 'a@x.com',
      fromName: 'Blue Dot',
      network: 'blue_dot',
      ctaUrl: 'https://seeker.example.org/auth/login',
      variables: { name: 'Asha' },
      // No itemId on this event → dedupe key omits the item segment.
      dedupeId: 'item_lifecycle:profile.create:u1',
      log: expect.any(Function),
    });
  });

  it('passes a per-(case,owner,item) dedupeId so NS does not drop it (#592 Blocker 1)', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', itemId: 'item-9', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(dispatchEmail.mock.calls[0]![0].dedupeId).toBe('item_lifecycle:profile.create:u1:item-9');
  });

  it('sends offer.update for a provider update', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true,name: 'Acme', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'update', ownerId: 'u1', domain: 'service_provider', network: 'purple_dot' },
      log,
    );
    expect(dispatchEmail.mock.calls[0]![0]).toMatchObject({ caseId: 'offer.update' });
  });

  it('sends account.aggregator_init with the org name for an aggregator create', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true,name: 'Asha', email: 'a@x.com' });
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
    expect(dispatchEmail.mock.calls[0]![0]).toMatchObject({
      caseId: 'account.aggregator_init',
      variables: { name: 'Asha', aggregatorOrg: 'SkillBridge Network' },
      log: expect.any(Function),
    });
  });

  it('falls back to the brand name when the aggregator org name is missing', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true,name: 'Asha', email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'seeker', network: 'blue_dot', actingOrgType: 'aggregator' },
      log,
    );
    expect(dispatchEmail.mock.calls[0]![0].variables).toMatchObject({ aggregatorOrg: 'Blue Dot' });
  });

  it('greets a nameless owner as "there"', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true,name: null, email: 'a@x.com' });
    await dispatchItemLifecycleNotification(
      { op: 'retire', ownerId: 'u1', domain: 'seeker', network: 'blue_dot' },
      log,
    );
    expect(dispatchEmail.mock.calls[0]![0].variables).toEqual({ name: 'there' });
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
    expect(dispatchEmail).not.toHaveBeenCalled();
  });
  it('links a provider-owned item to the provider portal, not the seeker one (#569)', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });

    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'provider', network: 'blue_dot' },
      log,
    );

    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    expect(dispatchEmail.mock.calls[0][0].ctaUrl).toBe('https://provider.example.org/auth/login');
  });

  it('skips the send when the domain resolves to no URL rather than shipping a dead link', async () => {
    configured();
    resolveOwnerNameEmail.mockResolvedValue({ found: true, name: 'Asha', email: 'a@x.com' });

    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: 'u1', domain: 'unmapped', network: 'blue_dot' },
      log,
    );

    expect(dispatchEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
