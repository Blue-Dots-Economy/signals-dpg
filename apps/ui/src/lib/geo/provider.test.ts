import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as runtimeEnv from '@/lib/runtime-env';
import { getGeoProvider } from './provider';

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
    expect(await provider.geocode(masked)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
