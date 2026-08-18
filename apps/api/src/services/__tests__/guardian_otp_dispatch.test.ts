import { describe, expect, it } from 'vitest';
import { buildGuardianEmailDispatch } from '../guardian_otp';

describe('buildGuardianEmailDispatch', () => {
  it('maps a scenario-less send to otp.generic', () => {
    const d = buildGuardianEmailDispatch({ otp: '123456', variables: {}, teamName: 'Blue Dot' });
    expect(d.caseId).toBe('otp.generic');
    expect(d.variables.otp).toBe('123456');
  });

  it('maps scenario kinds to guardian.* cases with fallback values', () => {
    const d = buildGuardianEmailDispatch({
      scenario: { kind: 'account' },
      otp: '111111',
      variables: {},
      teamName: 'Blue Dot',
    });
    expect(d.caseId).toBe('guardian.account');
    expect(d.variables).toMatchObject({
      otp: '111111',
      parentName: 'there',
      domain: 'Blue Dot', // falls back to teamName (copy has no conditionals)
      org: 'the organisation',
      teamName: 'Blue Dot',
    });
  });

  it('passes through provided parentName/domain/org', () => {
    const d = buildGuardianEmailDispatch({
      scenario: { kind: 'action', actionType: 'connect', stage: 'initiate' },
      otp: '1',
      variables: { parentName: 'Ravi', domain: 'yellow.example', providerOrgName: 'Acme' },
      teamName: 'X',
    });
    expect(d.variables.parentName).toBe('Ravi');
    expect(d.variables.org).toBe('Acme');
  });

  it('builds noun + escaped orgList for action_bulk', () => {
    const d = buildGuardianEmailDispatch({
      scenario: {
        kind: 'action_bulk',
        actionType: 'apply',
        stage: 'initiate',
        providerOrgNames: ['A&B', 'C'],
        jobs: true,
      },
      otp: '1',
      variables: {},
      teamName: 'X',
    });
    expect(d.caseId).toBe('guardian.action_bulk');
    expect(d.variables.noun).toBe('jobs');
    expect(d.variables.orgList).toBe('<ol><li>A&amp;B</li><li>C</li></ol>');
  });
});
