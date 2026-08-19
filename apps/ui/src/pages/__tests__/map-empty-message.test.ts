import { describe, it, expect } from 'vitest';
import { mapEmptyMessageKey, isWideViewport } from '../home-page';

describe('mapEmptyMessageKey', () => {
  it('reports a failed load as a failure, not an empty area', () => {
    // The map must not assert "no listings here" off the back of a request
    // that never succeeded — that states something it has not established.
    expect(mapEmptyMessageKey({ isError: true, wideViewport: false })).toBe('home.map_load_failed');
    expect(mapEmptyMessageKey({ isError: true, wideViewport: true })).toBe('home.map_load_failed');
  });

  it('does not tell a world-zoomed user to zoom out', () => {
    expect(mapEmptyMessageKey({ isError: false, wideViewport: true })).toBe('home.map_no_items_wide');
  });

  it('keeps the zoom-out hint for an ordinary viewport', () => {
    expect(mapEmptyMessageKey({ isError: false, wideViewport: false })).toBe(
      'home.map_no_items_in_area',
    );
  });
});

describe('isWideViewport', () => {
  it('is false without a viewport or without bounds', () => {
    expect(isWideViewport(null)).toBe(false);
    expect(isWideViewport({ lat: 0, lng: 0, radiusMeters: 1000 })).toBe(false);
  });

  it('is true only past the continental span', () => {
    const at = (span: number) => ({ lat: 0, lng: 0, radiusMeters: 1, minLat: -10, maxLat: 10, minLng: 0, maxLng: span });
    expect(isWideViewport(at(119))).toBe(false);
    expect(isWideViewport(at(120))).toBe(true);
    expect(isWideViewport(at(360))).toBe(true);
  });
});
