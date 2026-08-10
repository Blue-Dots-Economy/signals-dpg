import { describe, it, expect, vi } from 'vitest';
import { selectRequestedFields, type DomainContactContext } from '../contact_fields.js';

const log = { warn: vi.fn() };
const ctxBlueSeeker: DomainContactContext = {
  network: 'blue_dot', domain: 'seeker', itemType: 'profile_1.0',
  contactFields: { name: 'name', phone: 'phone' }, // no email mapping (account-only)
  nameFallbackField: 'name',
};

describe('selectRequestedFields', () => {
  it('returns canonical fields from item_state under canonical keys', () => {
    const out = selectRequestedFields(
      { name: 'Asha', phone: '+9190', gender: 'F' },
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['name', 'phone'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ name: 'Asha', phone: '+9190' }); // profile wins; gender not requested
  });

  it('falls back to account when the canonical field is missing/empty in item_state', () => {
    const out = selectRequestedFields(
      { name: 'Asha', phone: '' }, // phone empty, no email field in blue_dot seeker
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['email', 'phone'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ email: 'a@x.com', phone: '+9100' });
  });

  it('returns null for a canonical field absent in both item_state and account', () => {
    const out = selectRequestedFields(
      { name: 'Asha' },
      { name: 'acct', email: null, phone: null },
      ['email'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ email: null });
  });

  it('returns non-canonical fields raw and omits absent ones (no account read)', () => {
    const out = selectRequestedFields(
      { gender: 'F', age: '23' },
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['gender', 'missingField'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ gender: 'F' });
  });

  it('resolves name via nameFallbackField when contact_fields.name is unset', () => {
    const ctx: DomainContactContext = { ...ctxBlueSeeker, contactFields: {}, nameFallbackField: 'beneficiary_name' };
    const out = selectRequestedFields(
      { beneficiary_name: 'Meena' }, { name: 'acct', email: null, phone: null }, ['name'], ctx, log,
    );
    expect(out).toEqual({ name: 'Meena' });
  });

  it('warns when a phone/email canonical field has no mapping and no fallback', () => {
    log.warn.mockClear();
    const ctx: DomainContactContext = { ...ctxBlueSeeker, contactFields: {} };
    selectRequestedFields({}, { name: null, email: null, phone: null }, ['phone'], ctx, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
