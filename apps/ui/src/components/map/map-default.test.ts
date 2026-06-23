import { describe, expect, it } from 'vitest';

import {
  FALLBACK_CENTER,
  FALLBACK_ZOOM,
  parseDefaultCenter,
  parseDefaultZoom,
} from './map-container';

describe('parseDefaultCenter (VITE_MAP_DEFAULT_CENTER)', () => {
  it('parses a valid "lat,lng"', () => {
    expect(parseDefaultCenter('12.9716,77.5946')).toEqual([12.9716, 77.5946]);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDefaultCenter('  29.4727 , 77.7085 ')).toEqual([29.4727, 77.7085]);
  });

  it('falls back when unset', () => {
    expect(parseDefaultCenter(undefined)).toEqual(FALLBACK_CENTER);
    expect(parseDefaultCenter('')).toEqual(FALLBACK_CENTER);
  });

  it('falls back on malformed / out-of-range input', () => {
    expect(parseDefaultCenter('not,coords')).toEqual(FALLBACK_CENTER);
    expect(parseDefaultCenter('12.97')).toEqual(FALLBACK_CENTER); // missing lng
    expect(parseDefaultCenter('91,77')).toEqual(FALLBACK_CENTER); // lat > 90
    expect(parseDefaultCenter('12,200')).toEqual(FALLBACK_CENTER); // lng > 180
  });
});

describe('parseDefaultZoom (VITE_MAP_DEFAULT_ZOOM)', () => {
  it('parses a valid zoom', () => {
    expect(parseDefaultZoom('8')).toBe(8);
  });

  it('falls back when unset or invalid', () => {
    expect(parseDefaultZoom(undefined)).toBe(FALLBACK_ZOOM);
    expect(parseDefaultZoom('abc')).toBe(FALLBACK_ZOOM);
    expect(parseDefaultZoom('0')).toBe(FALLBACK_ZOOM);
    expect(parseDefaultZoom('30')).toBe(FALLBACK_ZOOM); // > 22
  });
});
