import { describe, expect, it, vi } from 'vitest';
import { NotifyTransportError, type NotifyEvent, type NotifyResult } from '@dpg/notification';

import type { NotificationEvent } from '../build_notifications';
import { createDirectDispatcher } from '../dispatcher';
import type { DispatcherDeps } from '../dispatcher';

const LOCAL = 'http://localhost:3000';

const ACCEPTED: NotifyResult = {
  ok: true,
  status: 202,
  body: { notification_event_id: 'ne-1', correlation_id: 'c-1' },
};

/** The only top-level fields an event send may carry from these senders. */
const EVENT_FIELDS = ['event_type', 'domain', 'to', 'variables', 'priority', 'idempotency_key'];

function createEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    lifecycle: 'created',
    actionType: 'connect',
    actionId: 'action-1',
    status: 'created',
    updateCount: 0,
    currentInstanceUrl: LOCAL,
    source: { ownerUserId: 'user-source', itemId: 'item-source', domain: 'seeker', network: 'blue_dot', instanceUrl: LOCAL },
    target: { ownerUserId: 'user-target', itemId: 'item-target', domain: 'service_provider', network: 'blue_dot', instanceUrl: LOCAL },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DispatcherDeps> = {}): {
  deps: DispatcherDeps;
  calls: NotifyEvent[];
  skips: string[];
} {
  const calls: NotifyEvent[] = [];
  const skips: string[] = [];
  const deps: DispatcherDeps = {
    send: vi.fn(async (event: NotifyEvent) => {
      calls.push(event);
      return ACCEPTED;
    }),
    resolveEmail: vi.fn(async (userId: string) => `${userId}@example.com`),
    // Default: counterparty is a seeker → no name resolved.
    resolveCounterpartyName: vi.fn(async () => null),
    teamName: 'EkStep',
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
  it('sends a connect inbound request to a service_provider recipient as action.connect.inbound_request', async () => {
    const { deps, calls } = makeDeps();
    await createDirectDispatcher(deps).dispatch(createEvent());

    expect(calls).toHaveLength(2);
    const inbound = calls.find((c) => c.event_type === 'action.connect.inbound_request');
    expect(inbound).toEqual({
      event_type: 'action.connect.inbound_request',
      // The recipient's own item domain, exactly as in network.json.
      domain: 'service_provider',
      to: { email: 'user-target@example.com' },
      variables: {
        name: 'the service provider',
        ctaUrl: 'https://provider.example.org/auth/login',
        teamName: 'EkStep',
      },
      priority: 'normal',
      idempotency_key: 'action-1:0:INBOUND_REQUEST',
    });

    const outbound = calls.find((c) => c.event_type === 'action.connect.outbound_request');
    expect(outbound).toMatchObject({
      domain: 'seeker',
      to: { email: 'user-source@example.com' },
      idempotency_key: 'action-1:0:OUTBOUND_REQUEST',
    });
  });

  it('sends a shortlist status change as action.shortlist.<inbound|outbound>_status with the true action type', async () => {
    const { deps, calls } = makeDeps({
      resolveCounterpartyName: vi.fn(async () => 'Acme Services'),
    });
    await createDirectDispatcher(deps).dispatch(
      createEvent({ actionType: 'shortlist', lifecycle: 'status', status: 'accepted', updateCount: 2 }),
    );

    const inboundStatus = calls.find((c) => c.event_type === 'action.shortlist.inbound_status');
    expect(inboundStatus).toMatchObject({
      domain: 'seeker',
      to: { email: 'user-source@example.com' },
      variables: { name: 'Acme Services', teamName: 'EkStep' },
      idempotency_key: 'action-1:2:INBOUND_STATUS',
    });
    expect(calls.map((c) => c.event_type).sort()).toEqual([
      'action.shortlist.inbound_status',
      'action.shortlist.outbound_status',
    ]);
  });

  it('carries teamName on every action event and never sends html, subject, template or channel', async () => {
    const { deps, calls } = makeDeps();
    await createDirectDispatcher(deps).dispatch(createEvent());
    await createDirectDispatcher(deps).dispatch(
      createEvent({ lifecycle: 'status', status: 'rejected', updateCount: 1 }),
    );

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.variables.teamName).toBe('EkStep');
      expect(Object.keys(call).every((k) => EVENT_FIELDS.includes(k))).toBe(true);
      expect(Object.keys(call.variables).sort()).toEqual(['ctaUrl', 'name', 'teamName']);
    }
  });

  it('skips and counts a side whose owner has no user id (no throw)', async () => {
    const { deps, calls, skips } = makeDeps();
    const event = createEvent({
      target: { ownerUserId: null, itemId: 'item-target', domain: 'provider', network: 'blue_dot', instanceUrl: LOCAL },
    });

    await createDirectDispatcher(deps).dispatch(event);

    // only the source-side OUTBOUND_REQUEST goes out
    expect(calls).toHaveLength(1);
    expect(calls[0].idempotency_key).toBe('action-1:0:OUTBOUND_REQUEST');
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
    expect(calls[0].to).toEqual({ email: 'user-source@example.com' });
    expect(skips).toContain('no_email');
  });

  it('logs a 422 from NS as ns_rejected and still sends the other side (best effort)', async () => {
    const { deps, calls } = makeDeps({
      send: vi.fn(async (event: NotifyEvent): Promise<NotifyResult> => {
        calls.push(event);
        return event.event_type.endsWith('inbound_request')
          ? { ok: false, status: 422, error: 'no_policy', kind: 'configuration' }
          : ACCEPTED;
      }),
    });

    await expect(createDirectDispatcher(deps).dispatch(createEvent())).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(deps.log).toHaveBeenCalledWith('ns_rejected', {
      event_type: 'action.connect.inbound_request',
      domain: 'service_provider',
      status: 422,
      error: 'no_policy',
      kind: 'configuration',
      actionId: 'action-1',
      shape: 'INBOUND_REQUEST',
    });
  });

  it('logs a transport failure as ns_unreachable and never throws', async () => {
    const { deps } = makeDeps({
      send: vi.fn(async () => {
        throw new NotifyTransportError('fetch failed: TypeError');
      }),
    });

    await expect(createDirectDispatcher(deps).dispatch(createEvent())).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      'ns_unreachable',
      expect.objectContaining({ event_type: 'action.connect.inbound_request', actionId: 'action-1' }),
    );
  });

  it('never throws when send rejects with an unexpected error (fire-and-forget)', async () => {
    const { deps } = makeDeps({
      send: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(createDirectDispatcher(deps).dispatch(createEvent())).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('notification dispatch failed', expect.anything());
  });

  it('falls back to FALLBACK_SERVICE_NAME when the counterparty name is null/empty', async () => {
    const { deps, calls } = makeDeps({
      resolveCounterpartyName: vi.fn(async () => '   '),
    });

    await createDirectDispatcher(deps).dispatch(
      createEvent({ lifecycle: 'status', status: 'accepted', updateCount: 1 }),
    );

    const inboundStatus = calls.find((c) => c.idempotency_key?.endsWith('INBOUND_STATUS'));
    expect(inboundStatus?.variables.name).toBe('the service provider');
  });

  it('sends each side to its OWN portal, not the counterparty portal', async () => {
    const { deps, calls } = makeDeps();
    // source = seeker, target = service_provider (see createEvent).
    await createDirectDispatcher(deps).dispatch(createEvent());

    const inbound = calls.find((c) => c.idempotency_key?.endsWith('INBOUND_REQUEST'));
    const outbound = calls.find((c) => c.idempotency_key?.endsWith('OUTBOUND_REQUEST'));

    expect(inbound?.variables.ctaUrl).toBe('https://provider.example.org/auth/login');
    expect(outbound?.variables.ctaUrl).toBe('https://seeker.example.org/auth/login');
  });

  it('skips a recipient whose domain resolves to no URL rather than sending a dead link', async () => {
    const { deps, calls, skips } = makeDeps({
      resolveCtaUrl: (domain: string) =>
        domain === 'seeker' ? 'https://seeker.example.org/auth/login' : undefined,
    });

    await createDirectDispatcher(deps).dispatch(createEvent());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables.ctaUrl).toBe('https://seeker.example.org/auth/login');
    expect(skips).toContain('no_cta_url');
  });
});
