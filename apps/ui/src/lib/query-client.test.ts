import { describe, it, expect } from 'vitest';
import { createQueryClient } from './query-client';

describe('createQueryClient', () => {
  it('disables focus-refetch and sets retry to 2', () => {
    const client = createQueryClient();
    const q = client.getDefaultOptions().queries;
    expect(q?.refetchOnWindowFocus).toBe(false);
    expect(q?.retry).toBe(2);
  });

  it('does not set a global staleTime (per-query tiers own it)', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.staleTime).toBeUndefined();
  });

  it('returns a fresh instance each call', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});
