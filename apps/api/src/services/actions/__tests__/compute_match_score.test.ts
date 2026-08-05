import { describe, it, expect, vi } from 'vitest';
import { computeActionMatchScore } from '../compute_match_score';

vi.mock('@/utils/match_score_client', () => ({
  getMatchScoreClient: () => ({
    calculate: vi.fn(async () => ({ provider: 'test', score: 7.4 })),
  }),
}));

const log = { warn: vi.fn(), error: vi.fn() } as any;

const baseSnapshot = {
  item_network: 'test_network',
  item_domain: 'test_domain',
  item_type: 'test_type_1.0',
  item_id: '550e8400-e29b-41d4-a716-446655440000',
  item_instance_url: 'https://instance.example.com',
  item_schema_url: 'https://schema.example.com/test_type_1.0.json',
};

describe('computeActionMatchScore', () => {
  it('returns the numeric score from the relevance client', async () => {
    const s = await computeActionMatchScore(
      { ...baseSnapshot, item_state: { a: 1 }, item_locations: [{ lat: 12.9, lng: 77.6 }] },
      { ...baseSnapshot, item_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', item_state: { b: 2 }, item_locations: [] },
      log,
    );
    expect(s).toBe(7.4);
  });

  it('returns null when either snapshot is missing', async () => {
    expect(await computeActionMatchScore(null as any, { ...baseSnapshot, item_state: {} }, log)).toBeNull();
  });
});
