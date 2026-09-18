import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sibling cache test pins `retry_backoff_ms: 0`, which short-circuits the
// backoff entirely. This file is the other side of that branch: a NON-zero
// backoff must actually be awaited between attempts.
const { get, set } = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => 'OK'),
}));
vi.mock('@api/db/secondary/redis', () => ({ redis: { get, set } }));
vi.mock('@/config', () => ({
  geocodingConfig: {
    google_api_key: 'test-key',
    photon_url: 'https://photon.example',
    cache_ttl_seconds: 2592000,
    cache_negative_ttl_seconds: 3600,
    retry_attempts: 2, // one initial + one retry
    retry_backoff_ms: 5, // non-zero: the sleep is exercised
  },
}));

import { resolveCoordinates } from '../geo_resolver.js';

const googleOk = {
  ok: true,
  json: async () => ({
    status: 'OK',
    results: [{ geometry: { location: { lat: 12.97, lng: 77.59 } } }],
  }),
};

beforeEach(() => {
  get.mockClear();
  set.mockClear();
});

describe('resolveCoordinates retry backoff', () => {
  it('sleeps between attempts and returns the retry result', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(googleOk);
    vi.stubGlobal('fetch', fetchMock);

    const started = Date.now();
    const result = await resolveCoordinates('Bengaluru');

    expect(result).toEqual({ lat: 12.97, lng: 77.59 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The 5ms backoff was actually awaited, not skipped.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);

    vi.unstubAllGlobals();
  });

  it('gives up after the configured attempts when every try throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    // Best-effort: the cache layer swallows a still-transient failure.
    await expect(resolveCoordinates('Bengaluru')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });
});
