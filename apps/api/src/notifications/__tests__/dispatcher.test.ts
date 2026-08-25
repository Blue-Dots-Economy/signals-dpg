import { describe, expect, it, vi } from 'vitest';

import type { NotificationEvent } from '../build_notifications';
import { createDirectDispatcher } from '../dispatcher';
import type { DispatcherDeps } from '../dispatcher';

const LOCAL = 'http://localhost:3000';

function createEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    lifecycle: 'created',
    actionType: 'connect',
    actionId: 'action-1',
    status: 'created',
    updateCount: 0,
    currentInstanceUrl: LOCAL,
    source: { ownerUserId: 'user-source', itemId: 'item-source', domain: 'seeker', network: 'blue_dot', instanceUrl: LOCAL },
    target: { ownerUserId: 'user-target', itemId: 'item-target', domain: 'provider', network: 'blue_dot', instanceUrl: LOCAL },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DispatcherDeps> = {}): {
  deps: DispatcherDeps;
  calls: Parameters<DispatcherDeps['sendEmail']>[0][];
  skips: string[];
} {
  const calls: Parameters<DispatcherDeps['sendEmail']>[0][] = [];
  const skips: string[] = [];
  const deps: DispatcherDeps = {
    sendEmail: vi.fn(async (args) => {
      calls.push(args);
      return { ok: true };
    }),
    resolveEmail: vi.fn(async (userId: string) => `${userId}@example.com`),
    // Default: counterparty is a seeker → no name resolved.
    resolveCounterpartyName: vi.fn(async () => null),
    brand: {
      brandName: 'Blue Dot',
    },
    resolveCtaUrl: (domain: string) =>
      domain === 'seeker'
        ? 'https://seeker.example.org/auth/login'
        : 'https://provider.example.org/auth/login',
    log: vi.fn(),
    onSkip: vi.fn((reason: string) => {
      skips.push(reason);
    }),
    ...overrides,
  };
  return { deps, calls, skips };
}

describe('DirectDispatcher', () => {
  it('sends one email per local owner side with the correct payload', async () => {
    const { deps, calls } = makeDeps();
    await createDirectDispatcher(deps).dispatch(createEvent());

    expect(calls).toHaveLength(2);

    // INBOUND_REQUEST → provider (target); provider-facing connect copy.
    const inbound = calls.find((c) => c.dedupeId?.endsWith('INBOUND_REQUEST'));
    expect(inbound).toMatchObject({
      caseId: 'action.connect.provider.inbound_request',
      to: 'user-target@example.com',
      fromName: 'Blue Dot',
      dedupeId: 'action-1:0:INBOUND_REQUEST',
    });
    expect(inbound?.variables?.name).toBe('the service provider');
  });

  it('skips and counts a side whose owner has no user id (no throw)', async () => {
    const { deps, calls, skips } = makeDeps();
    const event = createEvent({
      target: { ownerUserId: null, itemId: 'item-target', domain: 'provider', network: 'blue_dot', instanceUrl: LOCAL },
    });

    await createDirectDispatcher(deps).dispatch(event);

    // only the source-side OUTBOUND_REQUEST goes out
    expect(calls).toHaveLength(1);
    expect(calls[0].dedupeId).toBe('action-1:0:OUTBOUND_REQUEST');
    expect(skips).toContain('no_user_id');
  });

  it('skips and counts a recipient with no resolvable email', async () => {
    const { deps, calls, skips } = makeDeps({
      resolveEmail: vi.fn(async (userId: string) =>
        userId === 'user-target' ? null : `${userId}@example.com`,
      ),
    });

    await createDirectDispatcher(deps).dispatch(createEvent());

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('user-source@example.com');
    expect(skips).toContain('no_email');
  });

  it('never throws when sendEmail rejects (fire-and-forget)', async () => {
    const { deps } = makeDeps({
      sendEmail: vi.fn(async () => {
        throw new Error('NS down');
      }),
    });

    await expect(
      createDirectDispatcher(deps).dispatch(createEvent()),
    ).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalled();
  });

  it('substitutes the resolved provider service name into seeker-facing copy', async () => {
    const { deps, calls } = makeDeps({
      resolveCounterpartyName: vi.fn(async () => 'Acme Services'),
    });

    await createDirectDispatcher(deps).dispatch(
      createEvent({ lifecycle: 'status', status: 'accepted', updateCount: 1 }),
    );

    // INBOUND_STATUS → source (seeker); seeker-facing connect copy uses {{name}}.
    const inboundStatus = calls.find((c) => c.dedupeId?.endsWith('INBOUND_STATUS'));
    expect(inboundStatus?.to).toBe('user-source@example.com');
    expect(inboundStatus?.caseId).toBe('action.connect.seeker.inbound_status');
    expect(inboundStatus?.variables?.name).toBe('Acme Services');
  });

  it('falls back to FALLBACK_SERVICE_NAME when the counterparty name is null/empty', async () => {
    const { deps, calls } = makeDeps({
      resolveCounterpartyName: vi.fn(async () => null),
    });

    await createDirectDispatcher(deps).dispatch(
      createEvent({ lifecycle: 'status', status: 'accepted', updateCount: 1 }),
    );

    const inboundStatus = calls.find((c) => c.dedupeId?.endsWith('INBOUND_STATUS'));
    expect(inboundStatus?.variables?.name).toBe('the service provider');
  });

  it('sends each side to its OWN portal, not the counterparty portal', async () => {
    const { deps, calls } = makeDeps();
    // source = seeker, target = provider (see createEvent).
    await createDirectDispatcher(deps).dispatch(createEvent());

    const inbound = calls.find((c) => c.dedupeId?.endsWith('INBOUND_REQUEST'));
    const outbound = calls.find((c) => c.dedupeId?.endsWith('OUTBOUND_REQUEST'));

    // INBOUND_REQUEST goes to the TARGET (provider) → provider portal.
    expect(inbound?.ctaUrl).toBe('https://provider.example.org/auth/login');
    // OUTBOUND_REQUEST goes to the SOURCE (seeker) → seeker portal.
    expect(outbound?.ctaUrl).toBe('https://seeker.example.org/auth/login');
  });

  it('skips a recipient whose domain resolves to no URL rather than sending a dead link', async () => {
    // Reachable once the gate accepts a map-only config: UI_HOST_BINDINGS is
    // set (so the gate passes) but FRONTEND_BASE_URL is not, and this
    // recipient's domain is absent from the map. `dispatch_email` would render
    // `ctaUrl: args.ctaUrl ?? ''` into `<a href="">` — an email whose only
    // call to action is a broken button.
    const { deps, calls, skips } = makeDeps({
      resolveCtaUrl: (domain: string) =>
        domain === 'seeker' ? 'https://seeker.example.org/auth/login' : undefined,
    });

    await createDirectDispatcher(deps).dispatch(createEvent());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ctaUrl).toBe('https://seeker.example.org/auth/login');
    expect(skips).toContain('no_cta_url');
  });
});
