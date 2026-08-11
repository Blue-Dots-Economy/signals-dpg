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
    retry_attempts: 2, // one initial + one retry
    retry_backoff_ms: 0, // no real delay in tests
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

describe('resolveCoordinates negative caching (#196 fix)', () => {
  it('does NOT cache a transient provider error (retries on the next lookup)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveCoordinates('Bengaluru');
    const second = await resolveCoordinates('Bengaluru');

    expect(first).toBeNull();
    expect(second).toBeNull();
    // Each lookup runs retry_attempts (2) provider tries, and a persistently
    // transient failure is never cached → the second lookup retries live too.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });

  it('retries a transient failure once and succeeds on the second attempt (#405)', async () => {
    // First provider call fails transiently (HTTP 500 → throws), second succeeds.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(googleOk);
    vi.stubGlobal('fetch', fetchMock);

    const coord = await resolveCoordinates('Bengaluru');

    expect(coord).toEqual({ lat: 12.97, lng: 77.59 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial failed, retry succeeded
    // The recovered result is cached → a repeat lookup makes no new call.
    const again = await resolveCoordinates('Bengaluru');
    expect(again).toEqual({ lat: 12.97, lng: 77.59 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('does NOT retry a definitive ZERO_RESULTS (wrong address is not re-sent)', async () => {
    // A definitive not-found returns null (not a throw) → the retry loop must
    // not fire: exactly one provider call, then cached as a negative.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const coord = await resolveCoordinates('Definitely Not A Place 99999');

    expect(coord).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on a definitive miss
    vi.unstubAllGlobals();
  });

  it('caches a definitive ZERO_RESULTS as a negative (no second provider call)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveCoordinates('Nowhereville');
    const second = await resolveCoordinates('Nowhereville');

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // definitive → cached negative
    vi.unstubAllGlobals();
  });
});
