import { describe, it, expect } from 'vitest';
import {
  DecryptParticipantRequest,
  DecryptParticipantResponse,
} from '../participant_decrypt';

describe('DecryptParticipantRequest', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('accepts item_ids only', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: [uuid] });
    expect(r.success).toBe(true);
  });

  it('accepts user_id only', () => {
    const r = DecryptParticipantRequest.safeParse({ user_id: 'usr_1' });
    expect(r.success).toBe(true);
  });

  it('rejects both item_ids and user_id', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: [uuid], user_id: 'usr_1' });
    expect(r.success).toBe(false);
  });

  it('rejects neither', () => {
    const r = DecryptParticipantRequest.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects empty item_ids array', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: [] });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid item_ids', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: ['not-a-uuid'] });
    expect(r.success).toBe(false);
  });

  it('response schema accepts a profiles + skipped payload', () => {
    const r = DecryptParticipantResponse.safeParse({
      profiles: [
        {
          item_id: uuid,
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: { name: 'Velu Murugan' },
          created_at: '2026-06-26T12:03:04.686Z',
          updated_at: '2026-06-26T12:03:04.686Z',
        },
      ],
      skipped: ['22222222-2222-4222-8222-222222222222'],
    });
    expect(r.success).toBe(true);
  });
});

describe('DecryptParticipantRequest.fields', () => {
  it('accepts an optional fields array', () => {
    const r = DecryptParticipantRequest.parse({ item_ids: [crypto.randomUUID()], fields: ['name', 'phone'] });
    expect(r.fields).toEqual(['name', 'phone']);
  });

  it('accepts an empty fields array (contact-only: empty item_state)', () => {
    const r = DecryptParticipantRequest.parse({ item_ids: [crypto.randomUUID()], fields: [] });
    expect(r.fields).toEqual([]);
  });
  it('is valid when fields omitted (backward compatible)', () => {
    const r = DecryptParticipantRequest.parse({ item_ids: [crypto.randomUUID()] });
    expect(r.fields).toBeUndefined();
  });
  it('rejects empty-string field entries', () => {
    expect(() => DecryptParticipantRequest.parse({ user_id: 'u1', fields: [''] })).toThrow();
  });
});

// #521: `contact` and `include_locations` are independent, optional controls
// (see docs/superpowers/specs/2026-08-07-participant-decrypt-field-resolution-design.md §4/§8).
describe('DecryptParticipantRequest.contact', () => {
  it('accepts `true` (all three canonical fields)', () => {
    const r = DecryptParticipantRequest.parse({ user_id: 'u1', contact: true });
    expect(r.contact).toBe(true);
  });
  it('accepts a subset array', () => {
    const r = DecryptParticipantRequest.parse({ user_id: 'u1', contact: ['phone'] });
    expect(r.contact).toEqual(['phone']);
  });
  it('rejects `false` (omit the key instead of sending a redundant value)', () => {
    expect(() => DecryptParticipantRequest.parse({ user_id: 'u1', contact: false })).toThrow();
  });
  it('is valid when omitted', () => {
    const r = DecryptParticipantRequest.parse({ user_id: 'u1' });
    expect(r.contact).toBeUndefined();
  });
  it('rejects an empty array', () => {
    expect(() => DecryptParticipantRequest.parse({ user_id: 'u1', contact: [] })).toThrow();
  });
  it('rejects a value outside {name,email,phone}', () => {
    expect(() =>
      DecryptParticipantRequest.parse({ user_id: 'u1', contact: ['address'] }),
    ).toThrow();
  });
});

describe('DecryptParticipantRequest.include_locations', () => {
  it('accepts a boolean', () => {
    expect(DecryptParticipantRequest.parse({ user_id: 'u1', include_locations: true }).include_locations).toBe(true);
  });
  it('is valid when omitted', () => {
    expect(DecryptParticipantRequest.parse({ user_id: 'u1' }).include_locations).toBeUndefined();
  });
});

describe('DecryptedProfileSnapshot.contact / locations', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const base = {
    item_id: uuid,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Velu Murugan' },
    created_at: '2026-06-26T12:03:04.686Z',
    updated_at: '2026-06-26T12:03:04.686Z',
  };

  it('accepts a profile with no contact/locations (backward compatible)', () => {
    const r = DecryptParticipantResponse.safeParse({ profiles: [base], skipped: [] });
    expect(r.success).toBe(true);
  });

  it('accepts a contact block with value+source per canonical field, including nulls', () => {
    const r = DecryptParticipantResponse.safeParse({
      profiles: [
        {
          ...base,
          contact: {
            name: { value: 'Velu Murugan', source: 'item' },
            phone: { value: null, source: null },
            email: { value: 'v@example.com', source: 'user' },
          },
        },
      ],
      skipped: [],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a locations array of {lat,lng,label?}', () => {
    const r = DecryptParticipantResponse.safeParse({
      profiles: [{ ...base, locations: [{ lat: 12.9, lng: 77.5, label: 'Bengaluru' }, { lat: 1, lng: 1 }] }],
      skipped: [],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an invalid contact source', () => {
    const r = DecryptParticipantResponse.safeParse({
      profiles: [{ ...base, contact: { name: { value: 'x', source: 'admin' } } }],
      skipped: [],
    });
    expect(r.success).toBe(false);
  });
});
