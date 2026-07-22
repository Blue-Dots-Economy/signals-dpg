import { describe, it, expect } from 'vitest';
import { UpsertParticipantRequest } from '../participant.js';

const base = {
  phone_number: '+919900000011',
  name: 'Test Seeker',
  terms_accepted: true as const,
  privacy_accepted: true as const,
  channel: 'voice' as const,
  network: 'blue_dot',
  domain: 'seeker',
  item_type: 'profile_1.0',
  item_state: { name: 'Test Seeker' },
};

describe('UpsertParticipantRequest.create_new', () => {
  it('accepts create_new: true on its own', () => {
    const r = UpsertParticipantRequest.safeParse({ ...base, create_new: true });
    expect(r.success).toBe(true);
  });

  it('accepts omitting create_new (default upsert behaviour)', () => {
    const r = UpsertParticipantRequest.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('rejects create_new together with item_id (mutually exclusive)', () => {
    const r = UpsertParticipantRequest.safeParse({
      ...base,
      create_new: true,
      item_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('create_new'))).toBe(true);
    }
  });

  it('still allows item_id alone (update a specific item)', () => {
    const r = UpsertParticipantRequest.safeParse({
      ...base,
      item_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(r.success).toBe(true);
  });
});
