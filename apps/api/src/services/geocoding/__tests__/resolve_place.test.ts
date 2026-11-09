import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { store, get, set, incr, expire } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  const set = vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  });
  const incr = vi.fn(async (k: string) => {
    const n = Number(store.get(k) ?? 0) + 1;
    store.set(k, String(n));
    return n;
  });
  const expire = vi.fn(async () => 1);
  return { store, get, set, incr, expire };
});
vi.mock('@api/db/secondary/redis', () => ({ redis: { get, set, incr, expire } }));
vi.mock('@/config', () => ({
  geocodingConfig: {
    google_api_key: 'test-key',
    photon_url: 'https://photon.example',
    country: 'IN',
    cache_ttl_seconds: 2592000,
    cache_negative_ttl_seconds: 3600,
    retry_attempts: 2,
    retry_backoff_ms: 0,
  },
}));

import { resolvePlace, resolveCoordinates } from '../geo_resolver.js';

const googleBody = (formatted = 'Dharwad, Karnataka, India') => ({
  status: 'OK',
  results: [
    {
      formatted_address: formatted,
      types: ['locality', 'political'],
      address_components: [{ short_name: 'IN', types: ['country'] }],
      geometry: { location: { lat: 15.45, lng: 75.0 } },
    },
  ],
});
const ok = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  store.clear();
  get.mockClear();
  set.mockClear();
  incr.mockClear();
  expire.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('resolvePlace', () => {
  it('returns found, caches under the v2 key and serves the repeat from cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(googleBody()));
    vi.stubGlobal('fetch', fetchMock);

    const expected = {
      kind: 'found',
      place: {
        label: 'Dharwad, Karnataka, India',
        precision: 'city',
        point: { lat: 15.45, lng: 75.0 },
      },
    };
    expect(await resolvePlace('Dharwad')).toEqual(expected);
    expect(await resolvePlace(' dharwad ')).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.has('geo:place:v2:IN:dharwad')).toBe(true);
  });

  it('uses the trimmed query as label when the provider returns none', async () => {
    const body = googleBody();
    delete (body.results[0] as { formatted_address?: string }).formatted_address;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(body)));

    const r = await resolvePlace('  Dharwad ');
    expect(r).toMatchObject({ kind: 'found', place: { label: 'Dharwad' } });
  });

  it('returns not_found for ZERO_RESULTS and stores the negative sentinel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ status: 'ZERO_RESULTS', results: [] })));

    expect(await resolvePlace('Nowhereville')).toEqual({ kind: 'not_found' });
    expect(store.get('geo:place:v2:IN:nowhereville')).toBe('__no_result__');
  });

  it('returns not_found for an empty query without any I/O', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolvePlace('   ')).toEqual({ kind: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('returns unavailable/provider_error and stores nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ status: 'OVER_QUERY_LIMIT' })));

    expect(await resolvePlace('Dharwad', { retryAttempts: 1 })).toEqual({
      kind: 'unavailable',
      reason: 'provider_error',
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('maps an abort to unavailable/timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolvePlace('Dharwad', { timeoutMs: 1500, retryAttempts: 1 })).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });

  it('passes an abort signal to fetch when timeoutMs is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(googleBody()));
    vi.stubGlobal('fetch', fetchMock);

    await resolvePlace('Dharwad', { timeoutMs: 1500 });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('shares one provider call between concurrent misses', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const fetchMock = vi.fn().mockImplementation(async () => {
      await gate;
      return ok(googleBody('Hubli'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = resolvePlace('Hubli');
    const b = resolvePlace('Hubli');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    release(undefined);

    expect((await a).kind).toBe('found');
    expect((await b).kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not share a flight between a capped and an uncapped caller', async () => {
    store.set(`geo:spend:resolve:${new Date().toISOString().slice(0, 10)}`, '1');
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const fetchMock = vi.fn().mockImplementation(async () => {
      await gate;
      return ok(googleBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const capped = resolvePlace('Dharwad', { dailyCap: 1 });
    const uncapped = resolveCoordinates('Dharwad');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    release(undefined);

    expect(await capped).toEqual({ kind: 'unavailable', reason: 'spend_cap' });
    expect(await uncapped).toEqual({ lat: 15.45, lng: 75.0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one flight between concurrent calls with identical options', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const fetchMock = vi.fn().mockImplementation(async () => {
      await gate;
      return ok(googleBody());
    });
    vi.stubGlobal('fetch', fetchMock);
    const opts = { timeoutMs: 1500, retryAttempts: 1, dailyCap: 10 };

    const a = resolvePlace('Dharwad', opts);
    const b = resolvePlace('Dharwad', { ...opts });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    release(undefined);

    expect((await a).kind).toBe('found');
    expect((await b).kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps live provider calls per day, still serving cached queries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(googleBody()));
    vi.stubGlobal('fetch', fetchMock);

    expect((await resolvePlace('Dharwad', { dailyCap: 1 })).kind).toBe('found');
    expect(await resolvePlace('Hubli', { dailyCap: 1 })).toEqual({
      kind: 'unavailable',
      reason: 'spend_cap',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.has('geo:place:v2:IN:hubli')).toBe(false);
    expect((await resolvePlace('Dharwad', { dailyCap: 1 })).kind).toBe('found');
    expect(incr).toHaveBeenCalledTimes(2);
  });

  it('fails open when the spend counter errors', async () => {
    incr.mockRejectedValueOnce(new Error('redis down'));
    const fetchMock = vi.fn().mockResolvedValue(ok(googleBody()));
    vi.stubGlobal('fetch', fetchMock);

    expect((await resolvePlace('Dharwad', { dailyCap: 1 })).kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves item creation uncapped', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(googleBody()));
    vi.stubGlobal('fetch', fetchMock);

    await resolvePlace('Dharwad', { dailyCap: 1 });
    expect(await resolveCoordinates('Belagavi')).toEqual({ lat: 15.45, lng: 75.0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a v1 cache entry', async () => {
    store.set('geo:place:IN:dharwad', '{"lat":1,"lng":2}');
    const fetchMock = vi.fn().mockResolvedValue(ok(googleBody()));
    vi.stubGlobal('fetch', fetchMock);

    expect((await resolvePlace('Dharwad')).kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
