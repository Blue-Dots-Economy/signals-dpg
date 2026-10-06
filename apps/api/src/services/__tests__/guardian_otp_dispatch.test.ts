import { describe, expect, it } from 'vitest';
import { guardianEvent } from '@dpg/notification';
import { buildGuardianOtpEvent, formatOrgList } from '../guardian_otp';

describe('buildGuardianOtpEvent', () => {
  it('maps a scenario-less send to guardian.otp.generic carrying only the code', () => {
    const e = buildGuardianOtpEvent({
      contact: 'a@b.co',
      contactType: 'email',
      otp: '123456',
      variables: {},
      teamName: 'Blue Dot',
    });
    expect(e).toEqual({
      event_type: guardianEvent('generic'),
      domain: null,
      to: { email: 'a@b.co' },
      variables: { message: '123456' },
      priority: 'urgent',
    });
  });

  it('phone-only contact → to: {phone}, urgent, OTP only in variables.message', () => {
    const e = buildGuardianOtpEvent({
      contact: '+919800000000',
      contactType: 'phone',
      otp: '654321',
      scenario: { kind: 'action', actionType: 'connect', stage: 'initiate' },
      variables: { parentName: 'Asha', providerOrgName: 'Acme' },
      teamName: 'Blue Dot',
    });
    expect(e.to).toEqual({ phone: '+919800000000' });
    expect(e.priority).toBe('urgent');
    expect(e.variables.message).toBe('654321');
    // The code appears nowhere else in the event.
    const { message: _code, ...rest } = e.variables;
    expect(JSON.stringify({ ...e, variables: rest })).not.toContain('654321');
  });

  it('maps scenario kinds to guardian.otp.<kind> with fallback values', () => {
    const e = buildGuardianOtpEvent({
      contact: 'a@b.co',
      contactType: 'email',
      otp: '111111',
      scenario: { kind: 'account' },
      variables: {},
      teamName: 'Blue Dot',
    });
    expect(e.event_type).toBe('guardian.otp.account');
    expect(e.domain).toBeNull();
    expect(e.variables).toEqual({
      message: '111111',
      parentName: 'there',
      domain: 'Blue Dot', // falls back to teamName (copy has no conditionals)
      org: 'the organisation',
      teamName: 'Blue Dot',
    });
  });

  it('passes through provided parentName/domain/org', () => {
    const e = buildGuardianOtpEvent({
      contact: 'a@b.co',
      contactType: 'email',
      scenario: { kind: 'action', actionType: 'connect', stage: 'initiate' },
      otp: '1',
      variables: { parentName: 'Ravi', domain: 'yellow.example', providerOrgName: 'Acme' },
      teamName: 'X',
    });
    expect(e.event_type).toBe('guardian.otp.action');
    expect(e.variables).toMatchObject({ parentName: 'Ravi', domain: 'yellow.example', org: 'Acme' });
  });

  it('adds noun + a plain-text orgList for action_bulk', () => {
    const e = buildGuardianOtpEvent({
      contact: 'a@b.co',
      contactType: 'email',
      scenario: {
        kind: 'action_bulk',
        actionType: 'apply',
        stage: 'initiate',
        providerOrgNames: ['A&B', 'C', 'D'],
        jobs: true,
      },
      otp: '1',
      variables: {},
      teamName: 'X',
    });
    expect(e.event_type).toBe('guardian.otp.action_bulk');
    expect(e.variables.noun).toBe('jobs');
    // Plain text: NS escapes it when rendering.
    expect(e.variables.orgList).toBe('A&B, C and D');
    expect(e.variables.teamName).toBe('X');
  });

  it('action_bulk with no organisations gets the R5 filler orgList', () => {
    const e = buildGuardianOtpEvent({
      contact: 'a@b.co',
      contactType: 'email',
      scenario: { kind: 'action_bulk', actionType: 'apply', stage: 'initiate', providerOrgNames: [], jobs: false },
      otp: '1',
      variables: {},
      teamName: 'X',
    });
    expect(e.variables.noun).toBe('opportunities');
    expect(e.variables.orgList).toBe('the selected organisations');
  });

  it('carries no idempotency key, so two OTP challenges can never collapse into one send', () => {
    const args = {
      contact: 'a@b.co',
      contactType: 'email' as const,
      scenario: { kind: 'profile' as const },
      variables: {},
      teamName: 'X',
    };
    const first = buildGuardianOtpEvent({ ...args, otp: '111111' });
    const second = buildGuardianOtpEvent({ ...args, otp: '222222' });
    expect(first).not.toHaveProperty('idempotency_key');
    expect(second).not.toHaveProperty('idempotency_key');
  });
});

describe('formatOrgList', () => {
  it.each([
    [[], 'the selected organisations'],
    [['A'], 'A'],
    [['A', 'B'], 'A and B'],
    [['A', 'B', 'C'], 'A, B and C'],
  ])('%j → %s', (names, expected) => {
    expect(formatOrgList(names)).toBe(expected);
  });
});
