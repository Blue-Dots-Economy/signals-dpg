import { describe, expect, it } from 'vitest';
import {
  EMAIL_CASE_IDS,
  actionCaseId,
  getEmailCase,
  requiredMessageKeys,
} from '../email_cases';

describe('email case registry', () => {
  it('has 16 action cases + 23 named cases', () => {
    const actions = EMAIL_CASE_IDS.filter((id) => id.startsWith('action.'));
    expect(actions).toHaveLength(16);
    for (const id of [
      'retire.cancel',
      'guardian.account',
      'guardian.profile',
      'guardian.action',
      'guardian.action_bulk',
      'otp.generic',
      'login.otp',
      'welcome',
      'support.request',
      // Item-lifecycle emails (#531/#534).
      'profile.create',
      'offer.create',
      'profile.create_incomplete',
      'offer.create_incomplete',
      'profile.update',
      'offer.update',
      'account.aggregator_init.seeker',
      'account.aggregator_init.provider',
      'welcome.seeker',
      'welcome.provider',
      'profile.pause',
      'offer.pause',
      'profile.retire',
      'offer.retire',
    ]) {
      expect(EMAIL_CASE_IDS).toContain(id);
    }
    expect(EMAIL_CASE_IDS).toHaveLength(39);
  });

  it('maps plan fields to an action case id', () => {
    expect(actionCaseId('connect', 'seeker', 'INBOUND_REQUEST')).toBe(
      'action.connect.seeker.inbound_request',
    );
    expect(getEmailCase('action.connect.seeker.inbound_request').keys.subject).toBe(
      'action.connect.seeker.inbound_request.subject',
    );
  });

  it('classifies criticality per the spec', () => {
    expect(getEmailCase('guardian.account').criticality).toBe('critical');
    expect(getEmailCase('login.otp').criticality).toBe('critical');
    expect(getEmailCase('support.request').criticality).toBe('critical');
    expect(getEmailCase('action.connect.seeker.inbound_request').criticality).toBe('best_effort');
    expect(getEmailCase('retire.cancel').criticality).toBe('best_effort');
    expect(getEmailCase('welcome').criticality).toBe('best_effort');
  });

  it('only allowlists the code-built html tokens', () => {
    const htmlTokens = new Set<string>();
    for (const id of EMAIL_CASE_IDS) {
      const def = getEmailCase(id);
      for (const [name, type] of Object.entries(def.tokens)) {
        if (type === 'html') htmlTokens.add(name);
      }
    }
    // Every one of these is assembled in code from escaped parts (shells.ts /
    // build_support_email.ts) — that is what licenses inserting them raw.
    expect([...htmlTokens].sort()).toEqual([
      'detailsTable',
      'orgList',
      'otpBox',
      'siteLink',
    ]);
  });

  it('throws for unknown case ids', () => {
    expect(() => getEmailCase('nope')).toThrow('unknown email case: nope');
  });

  it('requiredMessageKeys covers subject+body(+cta) for every case', () => {
    const keys = requiredMessageKeys();
    // 29 cta-shell cases × 3 keys + 10 plain cases × 2 keys = 107
    // (2 added: profile/offer.create_incomplete — the draft-create nudge, #1 review)
    expect(keys).toHaveLength(107);
    expect(keys).toContain('retire.cancel.cta');
    expect(keys).toContain('welcome.body');
  });
});
