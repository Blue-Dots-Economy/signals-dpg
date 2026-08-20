import { describe, it, expect } from 'vitest';
import { splitLngRange, MAX_ENVELOPE_LNG_SPAN_DEGREES } from '../lng_chunks';

describe('splitLngRange', () => {
  it('leaves an ordinary viewport untouched', () => {
    expect(splitLngRange(68, 90)).toEqual([{ minLng: 68, maxLng: 90 }]);
  });

  it('splits a world viewport into chunks that geography can resolve', () => {
    // The whole point: ST_MakeEnvelope(...)::geography reads a span wider than
    // 180° as the short way round the globe, i.e. the complement of the box.
    const chunks = splitLngRange(-180, 180);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.maxLng - c.minLng).toBeLessThan(180);
  });

  it('covers the original range exactly, with no gaps or overlaps', () => {
    const chunks = splitLngRange(-180, 180);
    expect(chunks[0].minLng).toBe(-180);
    expect(chunks[chunks.length - 1].maxLng).toBe(180);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].minLng).toBeCloseTo(chunks[i - 1].maxLng, 9);
    }
  });

  it('splits right above the configured span and not right below it', () => {
    expect(splitLngRange(0, MAX_ENVELOPE_LNG_SPAN_DEGREES)).toHaveLength(1);
    expect(splitLngRange(0, MAX_ENVELOPE_LNG_SPAN_DEGREES + 0.1).length).toBeGreaterThan(1);
  });

  it('keeps every chunk under 180° for the spans that used to return zero', () => {
    // 180.1° was the first span that broke on the live API; 360° is world zoom.
    for (const span of [180.1, 205, 300, 360]) {
      for (const c of splitLngRange(-span / 2, span / 2)) {
        expect(c.maxLng - c.minLng).toBeLessThan(180);
      }
    }
  });
});
