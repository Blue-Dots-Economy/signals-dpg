import { describe, it, expect, vi } from 'vitest';
import { normalizeGeoKey, memoizeGeoLookup, withGeoCache } from './geo-cache';
import type { GeoProvider } from './types';

describe('normalizeGeoKey', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeGeoKey('  Noida,   Uttar   Pradesh ')).toBe('noida, uttar pradesh');
  });
  it('is stable across case/spacing variants', () => {
    expect(normalizeGeoKey('GHAZIABAD')).toBe(normalizeGeoKey('  ghaziabad '));
  });
});

describe('memoizeGeoLookup', () => {
  it('calls the underlying fn once for repeated (normalized) queries', async () => {
    const fn = vi.fn(async () => ['x'] as string[]);
    const memo = memoizeGeoLookup(fn, (v: string[]) => v.length > 0);
    await memo('Delhi');
    await memo('  DELHI ');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not collide distinct queries', async () => {
    const fn = vi.fn(async (q: string) => [q]);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
    await memo('Delhi');
    await memo('Mumbai');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent in-flight identical lookups to one call', async () => {
    let resolve!: (v: string[]) => void;
    const fn = vi.fn(() => new Promise<string[]>((r) => { resolve = r; }));
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
    const a = memo('Delhi');
    const b = memo('Delhi');
    resolve(['x']);
    expect(await a).toEqual(['x']);
    expect(await b).toEqual(['x']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not cache an un-cacheable (empty) result — retries next time', async () => {
    const fn = vi.fn(async () => [] as string[]);
    const memo = memoizeGeoLookup(fn, (v: string[]) => v.length > 0);
    await memo('Nowhere');
    await memo('Nowhere');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry past the cap (LRU)', async () => {
    const fn = vi.fn(async (q: string) => [q]);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0, 2);
    await memo('a'); // cached
    await memo('b'); // cached
    await memo('c'); // evicts 'a'
    await memo('a'); // 'a' was evicted → refetch
    expect(fn).toHaveBeenCalledTimes(4);
    fn.mockClear();
    await memo('c'); // still cached
    expect(fn).not.toHaveBeenCalled();
  });

  it('a cache hit refreshes recency so the hit entry is not the next evicted', async () => {
    const fn = vi.fn(async (q: string) => [q]);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0, 2);
    await memo('a');      // cached: [a]
    await memo('b');      // cached: [a,b]
    await memo('a');      // HIT → refreshes 'a' recency: [b,a]
    await memo('c');      // evicts oldest = 'b' (not 'a')
    fn.mockClear();
    await memo('a');      // still cached (recency refreshed) → no call
    expect(fn).not.toHaveBeenCalled();
    await memo('b');      // was evicted → refetch
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('memoizeGeoLookup ref-counted abort', () => {
  it('aborts the underlying call when the sole waiter aborts', async () => {
    const fn = vi.fn((_q: string, signal?: AbortSignal) =>
      new Promise<string[]>((resolve) => {
        signal?.addEventListener('abort', () => resolve(['ABORTED']));
      }));
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0 && v[0] !== 'ABORTED');
    const ctrl = new AbortController();
    const p = memo('delhi', ctrl.signal);
    ctrl.abort();
    expect(await p).toEqual(['ABORTED']); // underlying saw the abort
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT abort the shared call while another waiter is still active', async () => {
    let resolveFn!: (v: string[]) => void;
    const fn = vi.fn((_q: string, signal?: AbortSignal) =>
      new Promise<string[]>((resolve) => {
        signal?.addEventListener('abort', () => resolve(['ABORTED']));
        resolveFn = resolve;
      }));
    const memo = memoizeGeoLookup(fn, () => false);
    const a = new AbortController();
    const pA = memo('delhi', a.signal);       // waiter A (signal)
    const pB = memo('delhi');                 // waiter B (no signal → keeps alive)
    a.abort();                                // A aborts, B remains
    resolveFn(['OK']);                        // underlying completes normally
    expect(await pA).toEqual(['OK']);
    expect(await pB).toEqual(['OK']);
    expect(fn).toHaveBeenCalledTimes(1);      // deduped to one underlying call
  });

  it('aborts once ALL waiters have aborted', async () => {
    const fn = vi.fn((_q: string, signal?: AbortSignal) =>
      new Promise<string[]>((resolve) => {
        signal?.addEventListener('abort', () => resolve(['ABORTED']));
      }));
    const memo = memoizeGeoLookup(fn, (v) => v[0] !== 'ABORTED');
    const a = new AbortController();
    const b = new AbortController();
    const pA = memo('delhi', a.signal);
    const pB = memo('delhi', b.signal);
    a.abort();                                // still one waiter (B) → not aborted
    b.abort();                                // now zero → abort
    expect(await pA).toEqual(['ABORTED']);
    expect(await pB).toEqual(['ABORTED']);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withGeoCache', () => {
  it('caches suggest results per normalized query (one call for repeats)', async () => {
    const suggest = vi.fn().mockResolvedValue([{ lat: 1, lng: 2, label: 'Delhi' }]);
    const base: GeoProvider = { suggest, geocode: vi.fn() };
    const cached = withGeoCache(base);
    await cached.suggest('Delhi');
    await cached.suggest(' delhi ');
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('caches geocode results per normalized query (one call for repeats)', async () => {
    const geocode = vi.fn().mockResolvedValue({ lat: 1, lng: 2 });
    const base: GeoProvider = { suggest: vi.fn(), geocode };
    const cached = withGeoCache(base);
    await cached.geocode('Mumbai');
    await cached.geocode('MUMBAI');
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('does not cache a null geocode (transient/no-match) — retries', async () => {
    const geocode = vi.fn().mockResolvedValue(null);
    const base: GeoProvider = { suggest: vi.fn(), geocode };
    const cached = withGeoCache(base);
    await cached.geocode('Ghosttown');
    await cached.geocode('Ghosttown');
    expect(geocode).toHaveBeenCalledTimes(2);
  });

  it('keeps suggest and geocode caches independent', async () => {
    const suggest = vi.fn().mockResolvedValue([{ lat: 1, lng: 2, label: 'X' }]);
    const geocode = vi.fn().mockResolvedValue({ lat: 3, lng: 4 });
    const base: GeoProvider = { suggest, geocode };
    const cached = withGeoCache(base);
    await cached.suggest('Delhi');
    await cached.geocode('Delhi');
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(geocode).toHaveBeenCalledTimes(1);
  });
});
