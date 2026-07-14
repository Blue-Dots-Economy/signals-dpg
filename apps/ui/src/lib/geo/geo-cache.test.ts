import { describe, it, expect, vi } from 'vitest';
import { normalizeGeoKey, memoizeGeoLookup } from './geo-cache';

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
    const fn = vi.fn().mockResolvedValue(['x']);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
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
    const fn = vi.fn().mockResolvedValue([] as string[]);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
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
});
