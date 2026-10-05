import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as runtimeEnv from '@/lib/runtime-env';
import { getGeoProvider, normalizeCountry } from './provider';

describe('getGeoProvider PII-mask guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Force the key-less Photon (fetch-based) provider so the guard's "never
    // touches the network" assertion is checked against a real fetch path.
    vi.spyOn(runtimeEnv, 'getRuntimeEnv').mockReturnValue(undefined);
  });

  it('short-circuits a masked query without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = getGeoProvider();
    // looksLikePIIMask('***') is true: it matches the /\*{3,}/ mask-run check.
    const masked = '***';
    expect(await provider.suggest(masked)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('normalizeCountry (#785)', () => {
  it('upper-cases a two-letter code', () => {
    expect(normalizeCountry(' in ')).toBe('IN');
  });
  it('treats unset, blank, or malformed values as no restriction', () => {
    expect(normalizeCountry(undefined)).toBeUndefined();
    expect(normalizeCountry('')).toBeUndefined();
    expect(normalizeCountry('India')).toBeUndefined();
  });
});
