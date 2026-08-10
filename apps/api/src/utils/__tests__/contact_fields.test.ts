import { describe, it, expect, vi } from 'vitest';
import {
  projectItemState,
  resolveContact,
  normalizeContact,
  CANONICAL,
  type DomainContactContext,
} from '../contact_fields.js';

const log = { warn: vi.fn() };
const ctxBlueSeeker: DomainContactContext = {
  network: 'blue_dot', domain: 'seeker', itemType: 'profile_1.0',
  contactFields: { name: 'name', phone: 'phone' }, // no email mapping (account-only)
  nameFallbackField: 'name',
};

describe('projectItemState — pure item_state projection (#521)', () => {
  it('returns only the requested raw keys', () => {
    const out = projectItemState({ name: 'Asha', phone: '+9190', gender: 'F' }, ['gender']);
    expect(out).toEqual({ gender: 'F' });
  });

  it('omits absent/empty keys and never emits null', () => {
    const out = projectItemState({ name: 'Asha', phone: '' }, ['phone', 'missingField']);
    expect(out).toEqual({});
  });

  it('does NOT special-case canonical name/email/phone — reads them raw, no mapping/fallback', () => {
    // The domain's canonical "name" concept lives under `full_name`, but
    // `fields` is a pure projection: requesting the literal key "name" reads
    // item_state.name as-is (undefined here), never resolving via
    // contact_fields or falling back to the account.
    const out = projectItemState({ full_name: 'Asha' }, ['name']);
    expect(out).toEqual({});
  });

  it('projects multiple present keys together', () => {
    const out = projectItemState({ age: '23', gender: 'F', bio: 'hi' }, ['age', 'gender']);
    expect(out).toEqual({ age: '23', gender: 'F' });
  });
});

describe('normalizeContact', () => {
  it('true expands to all three canonical fields', () => {
    expect(normalizeContact(true)).toEqual([...CANONICAL]);
  });

  it('false and undefined both normalize to undefined (no contact block)', () => {
    expect(normalizeContact(false)).toBeUndefined();
    expect(normalizeContact(undefined)).toBeUndefined();
  });

  it('an array passes through as the requested subset', () => {
    expect(normalizeContact(['phone'])).toEqual(['phone']);
  });
});

describe('resolveContact — canonical contact block (#521)', () => {
  it('resolves from item_state (profile) when present — source "item"', () => {
    const out = resolveContact(
      { name: 'Asha', phone: '+9190', gender: 'F' },
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['name', 'phone'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({
      name: { value: 'Asha', source: 'item' },
      phone: { value: '+9190', source: 'item' },
    });
  });

  it('falls back to the account when the canonical field is missing/empty in item_state', () => {
    const out = resolveContact(
      { name: 'Asha', phone: '' }, // phone empty, no email field in blue_dot seeker
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['email', 'phone'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({
      email: { value: 'a@x.com', source: 'user' },
      phone: { value: '+9100', source: 'user' },
    });
  });

  it('resolves {value:null, source:null} when absent in both item_state and account', () => {
    const out = resolveContact(
      { name: 'Asha' },
      { name: 'acct', email: null, phone: null },
      ['email'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ email: { value: null, source: null } });
  });

  it('returns only the requested subset', () => {
    const out = resolveContact(
      { name: 'Asha', phone: '+9190' },
      { name: 'acct', email: 'a@x.com', phone: '+9100' },
      ['phone'], ctxBlueSeeker, log,
    );
    expect(Object.keys(out)).toEqual(['phone']);
  });

  it('profile wins when the canonical value exists in both item_state and account', () => {
    const out = resolveContact(
      { name: 'Asha' },
      { name: 'Account Name', email: null, phone: null },
      ['name'], ctxBlueSeeker, log,
    );
    expect(out).toEqual({ name: { value: 'Asha', source: 'item' } });
  });

  it('resolves name via nameFallbackField when contact_fields.name is unset', () => {
    const ctx: DomainContactContext = { ...ctxBlueSeeker, contactFields: {}, nameFallbackField: 'beneficiary_name' };
    const out = resolveContact(
      { beneficiary_name: 'Meena' }, { name: 'acct', email: null, phone: null }, ['name'], ctx, log,
    );
    expect(out).toEqual({ name: { value: 'Meena', source: 'item' } });
  });

  it('warns when a requested phone/email canonical field has no mapping (PII-free)', () => {
    log.warn.mockClear();
    const ctx: DomainContactContext = { ...ctxBlueSeeker, contactFields: {} };
    resolveContact({}, { name: null, email: null, phone: null }, ['phone'], ctx, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(obj).not.toHaveProperty('value');
    expect(JSON.stringify(obj)).not.toMatch(/\+?\d{5,}/); // no phone-shaped value leaked
  });

  it('does not warn for name (has a default fallback, not a hard mapping requirement)', () => {
    log.warn.mockClear();
    const ctx: DomainContactContext = { network: 'blue_dot', domain: 'seeker', itemType: 'profile_1.0' };
    resolveContact({}, { name: null, email: null, phone: null }, ['name'], ctx, log);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
