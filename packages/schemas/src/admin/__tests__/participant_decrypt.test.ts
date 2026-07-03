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
