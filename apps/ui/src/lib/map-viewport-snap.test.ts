import { describe, it, expect } from 'vitest';
import { snapBbox, snapViewportForKey, padBbox, bboxContains, shouldRefetch, clampBbox, expandBboxForFetch } from './map-viewport-snap';

// Span 0.5deg → cell = 0.5/8 = 0.0625deg exactly (a power of two already, so
// no bucketing rounding to reason about). All four corners are exact
// multiples of that cell (19.0, 19.5, 72.0, 72.5 ÷ 0.0625 are integers), so
// they sit dead-center in their grid cell rather than near a boundary.
const BASE_BBOX = { minLat: 19.0, minLng: 72.0, maxLat: 19.5, maxLng: 72.5 };

describe('snapBbox', () => {
  it('snaps identical bboxes to the identical value', () => {
    expect(snapBbox(BASE_BBOX)).toEqual(snapBbox({ ...BASE_BBOX }));
  });

  it('snaps a tiny pan (well within a grid cell) to the same value as the original', () => {
    // Cell is 0.0625deg (half-cell 0.03125); a 0.01deg pan stays inside it.
    const panned = {
      minLat: BASE_BBOX.minLat + 0.01,
      minLng: BASE_BBOX.minLng + 0.01,
      maxLat: BASE_BBOX.maxLat + 0.01,
      maxLng: BASE_BBOX.maxLng + 0.01,
    };
    expect(snapBbox(panned)).toEqual(snapBbox(BASE_BBOX));
  });

  it('snaps a bbox contained well inside the original to the same value', () => {
    // A slight zoom-in that stays inside the same grid cell.
    const contained = {
      minLat: BASE_BBOX.minLat + 0.01,
      minLng: BASE_BBOX.minLng + 0.01,
      maxLat: BASE_BBOX.maxLat - 0.01,
      maxLng: BASE_BBOX.maxLng - 0.01,
    };
    expect(snapBbox(contained)).toEqual(snapBbox(BASE_BBOX));
  });

  it('produces a different value for a pan that crosses a grid cell', () => {
    // A pan larger than the cell size (0.0625deg) crosses into a new cell.
    const panned = {
      minLat: BASE_BBOX.minLat + 0.1,
      minLng: BASE_BBOX.minLng + 0.1,
      maxLat: BASE_BBOX.maxLat + 0.1,
      maxLng: BASE_BBOX.maxLng + 0.1,
    };
    expect(snapBbox(panned)).not.toEqual(snapBbox(BASE_BBOX));
  });

  it('uses a finer grid for a smaller (more zoomed-in) bbox', () => {
    // Span 0.002deg → span/8 = 0.00025, below MIN_SNAP_CELL_DEG (0.001), so
    // the cell floors at 0.001deg (half-cell 0.0005) — far finer than
    // BASE_BBOX's 0.0625deg cell.
    const tinyBbox = { minLat: 19.0, minLng: 72.0, maxLat: 19.002, maxLng: 72.002 };
    // A 0.0007deg pan is bigger than the tiny grid's half-cell (0.0005) and
    // so crosses it, even though it would be swallowed many times over by
    // BASE_BBOX's much coarser grid.
    const tinyPanned = {
      minLat: tinyBbox.minLat + 0.0007,
      minLng: tinyBbox.minLng + 0.0007,
      maxLat: tinyBbox.maxLat + 0.0007,
      maxLng: tinyBbox.maxLng + 0.0007,
    };
    expect(snapBbox(tinyPanned)).not.toEqual(snapBbox(tinyBbox));
  });
});

describe('snapViewportForKey', () => {
  it('returns null when the viewport has no bbox (radius-only callers)', () => {
    expect(snapViewportForKey({})).toBeNull();
  });

  it('returns the snapped bbox when the viewport has a bbox', () => {
    expect(snapViewportForKey(BASE_BBOX)?.snappedBbox).toEqual(snapBbox(BASE_BBOX));
  });

  it('same/contained viewport → identical result', () => {
    const contained = {
      minLat: BASE_BBOX.minLat + 0.01,
      minLng: BASE_BBOX.minLng + 0.01,
      maxLat: BASE_BBOX.maxLat - 0.01,
      maxLng: BASE_BBOX.maxLng - 0.01,
    };
    expect(snapViewportForKey(BASE_BBOX)).toEqual(snapViewportForKey(contained));
  });

  it('a pan crossing a grid cell produces a different result', () => {
    const panned = {
      minLat: BASE_BBOX.minLat + 0.1,
      minLng: BASE_BBOX.minLng + 0.1,
      maxLat: BASE_BBOX.maxLat + 0.1,
      maxLng: BASE_BBOX.maxLng + 0.1,
    };
    expect(snapViewportForKey(BASE_BBOX)).not.toEqual(snapViewportForKey(panned));
  });
});

// #203 map-serverside-search Task 5: the refetch state machine's pure
// building blocks (padded bbox + containment + the decision itself).
describe('padBbox', () => {
  it('inflates a bbox by 25% of its own span by default, split evenly on both sides', () => {
    // Span 0.5deg on each axis → 25% = 0.125deg total → 0.0625deg per side.
    expect(padBbox(BASE_BBOX)).toEqual({
      minLat: BASE_BBOX.minLat - 0.0625,
      minLng: BASE_BBOX.minLng - 0.0625,
      maxLat: BASE_BBOX.maxLat + 0.0625,
      maxLng: BASE_BBOX.maxLng + 0.0625,
    });
  });

  it('honors a custom factor', () => {
    expect(padBbox(BASE_BBOX, 1)).toEqual({
      minLat: BASE_BBOX.minLat - 0.25,
      minLng: BASE_BBOX.minLng - 0.25,
      maxLat: BASE_BBOX.maxLat + 0.25,
      maxLng: BASE_BBOX.maxLng + 0.25,
    });
  });
});

describe('bboxContains', () => {
  it('is true when the inner bbox is fully inside the outer bbox', () => {
    const inner = { minLat: 19.1, minLng: 72.1, maxLat: 19.4, maxLng: 72.4 };
    expect(bboxContains(BASE_BBOX, inner)).toBe(true);
  });

  it('is true for an identical bbox (containment is inclusive)', () => {
    expect(bboxContains(BASE_BBOX, { ...BASE_BBOX })).toBe(true);
  });

  it('is false when the inner bbox escapes any edge of the outer bbox', () => {
    expect(bboxContains(BASE_BBOX, { ...BASE_BBOX, maxLat: BASE_BBOX.maxLat + 0.01 })).toBe(false);
    expect(bboxContains(BASE_BBOX, { ...BASE_BBOX, minLng: BASE_BBOX.minLng - 0.01 })).toBe(false);
  });
});

describe('shouldRefetch', () => {
  const inner = { minLat: 19.1, minLng: 72.1, maxLat: 19.4, maxLng: 72.4 };
  const paddedBbox = padBbox(BASE_BBOX);

  it('refetches when there is no prior padded bbox to compare against', () => {
    expect(shouldRefetch({ newBbox: inner, paddedBbox: null, lastTruncated: false })).toBe(true);
  });

  it('skips the refetch for a contained bbox when the last result was complete', () => {
    expect(shouldRefetch({ newBbox: inner, paddedBbox, lastTruncated: false })).toBe(false);
  });

  it('refetches for a contained bbox when the last result was truncated', () => {
    expect(shouldRefetch({ newBbox: inner, paddedBbox, lastTruncated: true })).toBe(true);
  });

  it('refetches when the new bbox escapes the padded bbox, even if the last result was complete', () => {
    const outside = { ...inner, maxLat: paddedBbox.maxLat + 0.01 };
    expect(shouldRefetch({ newBbox: outside, paddedBbox, lastTruncated: false })).toBe(true);
  });
});

describe('clampBbox', () => {
  it('leaves an in-range bbox untouched', () => {
    const bbox = { minLat: 8, minLng: 68, maxLat: 31, maxLng: 90 };
    expect(clampBbox(bbox)).toEqual(bbox);
  });

  it('clamps the longitudes a zoomed-out provider reports past ±180', () => {
    // The live 400: `querystring/max_lng Too big: expected number to be <=180`.
    // The request was rejected outright, so the map looked empty rather than
    // broken.
    expect(clampBbox({ minLat: 8, minLng: -220, maxLat: 31, maxLng: 240 })).toEqual({
      minLat: 8,
      minLng: -180,
      maxLat: 31,
      maxLng: 180,
    });
  });

  it('clamps latitudes to the furthest north and south the map can show', () => {
    expect(clampBbox({ minLat: -120, minLng: 10, maxLat: 120, maxLng: 20 })).toEqual({
      minLat: -85.05112878,
      minLng: 10,
      maxLat: 85.05112878,
      maxLng: 20,
    });
  });

  it('treats an antimeridian-wrapped range as the whole world', () => {
    // minLng > maxLng means the viewport crosses ±180; there is no single
    // envelope for that, and at the zoom where it happens the user is looking
    // at the whole world anyway.
    expect(clampBbox({ minLat: -10, minLng: 170, maxLat: 10, maxLng: -170 })).toEqual({
      minLat: -10,
      minLng: -180,
      maxLat: 10,
      maxLng: 180,
    });
  });

  it('collapses a more-than-one-revolution span to the whole world', () => {
    expect(clampBbox({ minLat: -10, minLng: -400, maxLat: 10, maxLng: 400 })).toEqual({
      minLat: -10,
      minLng: -180,
      maxLat: 10,
      maxLng: 180,
    });
  });
});

describe('expandBboxForFetch', () => {
  it('pads the bbox by 25% of its span on each side', () => {
    expect(expandBboxForFetch({ minLat: 10, minLng: 70, maxLat: 20, maxLng: 80 })).toEqual({
      minLat: 7.5,
      minLng: 67.5,
      maxLat: 22.5,
      maxLng: 82.5,
    });
  });

  it('clamps a padded world-wide bbox to valid coordinates', () => {
    expect(expandBboxForFetch({ minLat: -80, minLng: -179, maxLat: 80, maxLng: 179 })).toEqual({
      minLat: -85.05112878,
      minLng: -180,
      maxLat: 85.05112878,
      maxLng: 180,
    });
  });
});
