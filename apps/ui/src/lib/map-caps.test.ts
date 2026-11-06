import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveMarkerCap, SEARCH_AREA_MIN_ZOOM } from './map-caps';
import * as runtimeEnv from './runtime-env';

function mockRuntimeEnv(values: Record<string, string | undefined>) {
  vi.spyOn(runtimeEnv, 'getRuntimeEnv').mockImplementation(
    ((k: string) => values[k]) as unknown as typeof runtimeEnv.getRuntimeEnv,
  );
}

describe('resolveMarkerCap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads VITE_MAP_MARKER_CAP', () => {
    mockRuntimeEnv({ VITE_MAP_MARKER_CAP: '24999' });
    expect(resolveMarkerCap()).toBe(24999);
  });

  it.each([undefined, '', 'not-a-number', '0', '-5', '12.5'])('falls back to 10000 for %s', (raw) => {
    mockRuntimeEnv({ VITE_MAP_MARKER_CAP: raw });
    expect(resolveMarkerCap()).toBe(10000);
  });
});

describe('SEARCH_AREA_MIN_ZOOM', () => {
  it('sits at street level, not city level', () => {
    // Regression: at 10 the whole of Bengaluru fit on screen and "Search this
    // area" was still offered. Filtering a list to a whole metro is
    // indistinguishable from not filtering it, so the button read as noise.
    // 15 is where Google's tiles start naming individual streets.
    expect(SEARCH_AREA_MIN_ZOOM).toBeGreaterThanOrEqual(15);
  });
});
