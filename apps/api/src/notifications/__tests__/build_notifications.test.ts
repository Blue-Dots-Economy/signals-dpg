import { describe, expect, it } from 'vitest';

import { buildNotifications } from '../build_notifications';
import type { NotificationEvent } from '../build_notifications';

const LOCAL = 'http://localhost:3000';

const baseSides = {
  source: {
    ownerUserId: 'user-source',
    itemId: 'item-source',
    domain: 'seeker',
    network: 'blue_dot',
    instanceUrl: LOCAL,
  },
  target: {
    ownerUserId: 'user-target',
    itemId: 'item-target',
    domain: 'provider',
    network: 'blue_dot',
    instanceUrl: LOCAL,
  },
};

function event(overrides: Partial<NotificationEvent>): NotificationEvent {
  return {
    lifecycle: 'created',
    actionType: 'connect',
    actionId: 'action-1',
    status: 'created',
    updateCount: 0,
    currentInstanceUrl: LOCAL,
    ...baseSides,
    ...overrides,
  };
}

describe('buildNotifications — single instance', () => {
  it('on create fans out INBOUND_REQUEST to target and OUTBOUND_REQUEST to source', () => {
    const plans = buildNotifications(event({ lifecycle: 'created' }));

    expect(plans).toHaveLength(2);

    const inbound = plans.find((p) => p.shape === 'INBOUND_REQUEST');
    expect(inbound).toMatchObject({
      recipientUserId: 'user-target',
      recipientDomain: 'provider',
      counterpartyDomain: 'seeker',
      counterpartyItemId: 'item-source',
      actionType: 'connect',
    });

    const outbound = plans.find((p) => p.shape === 'OUTBOUND_REQUEST');
    expect(outbound).toMatchObject({
      recipientUserId: 'user-source',
      recipientDomain: 'seeker',
      counterpartyDomain: 'provider',
      counterpartyItemId: 'item-target',
    });
  });

  it('on status change fans out INBOUND_STATUS to source and OUTBOUND_STATUS to target', () => {
    const plans = buildNotifications(
      event({ lifecycle: 'status', status: 'accepted', updateCount: 1 }),
    );

    expect(plans).toHaveLength(2);

    const inbound = plans.find((p) => p.shape === 'INBOUND_STATUS');
    expect(inbound).toMatchObject({
      recipientUserId: 'user-source',
      counterpartyDomain: 'provider',
      status: 'accepted',
      updateCount: 1,
    });

    const outbound = plans.find((p) => p.shape === 'OUTBOUND_STATUS');
    expect(outbound).toMatchObject({
      recipientUserId: 'user-target',
      counterpartyDomain: 'seeker',
    });
  });
});

describe('buildNotifications — locality (Phase 2 readiness)', () => {
  it('emits only the inbound side when the source is on a remote instance (create)', () => {
    const plans = buildNotifications(
      event({
        lifecycle: 'created',
        source: { ...baseSides.source, instanceUrl: 'https://remote.example.com' },
      }),
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      shape: 'INBOUND_REQUEST',
      recipientUserId: 'user-target',
    });
  });

  it('emits only the outbound confirmation when the target is remote (create)', () => {
    const plans = buildNotifications(
      event({
        lifecycle: 'created',
        target: { ...baseSides.target, instanceUrl: 'https://remote.example.com' },
      }),
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      shape: 'OUTBOUND_REQUEST',
      recipientUserId: 'user-source',
    });
  });
});
