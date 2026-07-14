import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stateful in-memory Redis so a stored value is visible to the next get —
// proves a repeat lookup is served from cache (no second provider call).
// vi.hoisted is required because vi.mock factories are hoisted above local
// const declarations; referencing them directly throws a TDZ error.
const { store, get, set } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  const set = vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; });
  return { store, get, set };
});
vi.mock('@api/db/secondary/redis', () => ({ redis: { get, set } }));
vi.mock('@/config', () => ({
  geocodingConfig: {
    google_api_key: 'test-key',
    photon_url: 'https://photon.example',
    cache_ttl_seconds: 2592000,
    cache_negative_ttl_seconds: 3600,
  },
}));

import { resolveCoordinates } from '../geo_resolver.js';

const googleOk = {
  ok: true,
  json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 12.97, lng: 77.59 } } }] }),
};

beforeEach(() => { store.clear(); get.mockClear(); set.mockClear(); });

describe('resolveCoordinates caching (#196)', () => {
  it('calls the provider once for repeated identical lookups', async () => {
    const fetchMock = vi.fn().mockResolvedValue(googleOk);
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveCoordinates('Bengaluru');
    const second = await resolveCoordinates('  BENGALURU ');

    expect(first).toEqual({ lat: 12.97, lng: 77.59 });
    expect(second).toEqual({ lat: 12.97, lng: 77.59 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
    vi.unstubAllGlobals();
  });
});
