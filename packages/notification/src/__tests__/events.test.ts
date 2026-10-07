import { describe, it, expect } from 'vitest';
import {
  ACTION_CANCELLED_BY_RETIRE,
  ACTION_EVENT_SHAPES,
  GUARDIAN_OTP_KINDS,
  ITEM_EVENT,
  ITEM_ONBOARDED,
  SUPPORT_REQUEST,
  USER_WELCOME,
  actionEvent,
  guardianEvent,
  type ActionEventShape,
  type GuardianOtpKind,
} from '../events';

describe('actionEvent', () => {
  it.each([
    ['connect', 'inbound_request', 'action.connect.inbound_request'],
    ['apply', 'outbound_request', 'action.apply.outbound_request'],
    ['shortlist', 'inbound_status', 'action.shortlist.inbound_status'],
    ['connect', 'outbound_status', 'action.connect.outbound_status'],
  ] as const)('%s + %s → %s', (type, shape, expected) => {
    expect(actionEvent(type, shape)).toBe(expected);
  });

  it('covers exactly the four shapes of the event table', () => {
    expect([...ACTION_EVENT_SHAPES]).toEqual([
      'inbound_request',
      'outbound_request',
      'inbound_status',
      'outbound_status',
    ]);
  });

  it.each(['', 'a.b'])('rejects the action type %j', (type) => {
    expect(() => actionEvent(type, 'inbound_request')).toThrow(/action type/);
  });

  it('rejects an unknown shape', () => {
    expect(() => actionEvent('connect', 'sideways' as ActionEventShape)).toThrow(/shape/);
  });
});

describe('fixed event names', () => {
  it('item lifecycle events', () => {
    expect(ITEM_EVENT).toEqual({
      created: 'item.created',
      created_draft: 'item.created_draft',
      updated: 'item.updated',
      paused: 'item.paused',
      retired: 'item.retired',
    });
  });

  it('the remaining single events', () => {
    expect(ITEM_ONBOARDED).toBe('item.onboarded_by_aggregator');
    expect(ACTION_CANCELLED_BY_RETIRE).toBe('action.cancelled_by_retire');
    expect(USER_WELCOME).toBe('user.welcome');
    expect(SUPPORT_REQUEST).toBe('support.request');
  });
});

describe('guardianEvent', () => {
  it.each([
    ['account', 'guardian.otp.account'],
    ['profile', 'guardian.otp.profile'],
    ['action', 'guardian.otp.action'],
    ['action_bulk', 'guardian.otp.action_bulk'],
    ['generic', 'guardian.otp.generic'],
  ] as const)('%s → %s', (kind, expected) => {
    expect(guardianEvent(kind)).toBe(expected);
  });

  it('lists the four scenario kinds', () => {
    expect([...GUARDIAN_OTP_KINDS]).toEqual(['account', 'profile', 'action', 'action_bulk']);
  });

  it('rejects an unknown kind', () => {
    expect(() => guardianEvent('ward' as GuardianOtpKind)).toThrow(/unknown kind/);
  });
});

describe('the package entry point', () => {
  it('re-exports the event builders', async () => {
    const pkg = await import('../index');
    expect(pkg.actionEvent).toBe(actionEvent);
    expect(pkg.guardianEvent).toBe(guardianEvent);
    expect(pkg.USER_WELCOME).toBe(USER_WELCOME);
  });
});
