import { describe, it, expect } from 'vitest';
import {
  snapBbox,
  zoomBand,
  snapViewportForKey,
  DEFAULT_CLUSTER_DISABLE_ZOOM,
  padBbox,
  bboxContains,
  shouldRefetch,
} from './map-viewport-snap';

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

describe('zoomBand', () => {
  it('bands a zoom below the cluster-disable threshold as clustered', () => {
    expect(zoomBand(DEFAULT_CLUSTER_DISABLE_ZOOM - 1)).toBe('clustered');
    expect(zoomBand(0)).toBe('clustered');
  });

  it('bands a zoom at/above the cluster-disable threshold as individual', () => {
    expect(zoomBand(DEFAULT_CLUSTER_DISABLE_ZOOM)).toBe('individual');
    expect(zoomBand(DEFAULT_CLUSTER_DISABLE_ZOOM + 5)).toBe('individual');
  });

  it('two zooms within the same band produce the same band value', () => {
    expect(zoomBand(6)).toBe(zoomBand(9));
  });

  it('a zoom crossing the band boundary produces a different band value', () => {
    expect(zoomBand(DEFAULT_CLUSTER_DISABLE_ZOOM - 1)).not.toBe(zoomBand(DEFAULT_CLUSTER_DISABLE_ZOOM));
  });

  it('respects a custom cluster-disable-zoom threshold', () => {
    expect(zoomBand(10, 10)).toBe('individual');
    expect(zoomBand(9, 10)).toBe('clustered');
  });
});

describe('snapViewportForKey', () => {
  it('returns null when the viewport has no bbox (radius-only callers)', () => {
    expect(snapViewportForKey({ zoom: 10 })).toBeNull();
  });

  it('returns the snapped bbox + zoom band when the viewport has a bbox', () => {
    const result = snapViewportForKey({ ...BASE_BBOX, zoom: 12 });
    expect(result).not.toBeNull();
    expect(result?.snappedBbox).toEqual(snapBbox(BASE_BBOX));
    expect(result?.zoomBand).toBe('clustered');
  });

  it('same/contained viewport + same zoom band → identical result', () => {
    const a = snapViewportForKey({ ...BASE_BBOX, zoom: 8 });
    const contained = {
      minLat: BASE_BBOX.minLat + 0.01,
      minLng: BASE_BBOX.minLng + 0.01,
      maxLat: BASE_BBOX.maxLat - 0.01,
      maxLng: BASE_BBOX.maxLng - 0.01,
    };
    const b = snapViewportForKey({ ...contained, zoom: 9 });
    expect(a).toEqual(b);
  });

  it('a pan crossing a grid cell produces a different result', () => {
    const a = snapViewportForKey({ ...BASE_BBOX, zoom: 8 });
    const panned = {
      minLat: BASE_BBOX.minLat + 0.1,
      minLng: BASE_BBOX.minLng + 0.1,
      maxLat: BASE_BBOX.maxLat + 0.1,
      maxLng: BASE_BBOX.maxLng + 0.1,
    };
    const b = snapViewportForKey({ ...panned, zoom: 8 });
    expect(a).not.toEqual(b);
  });

  it('a zoom crossing the cluster-disable band produces a different result even with the same bbox', () => {
    const a = snapViewportForKey({ ...BASE_BBOX, zoom: DEFAULT_CLUSTER_DISABLE_ZOOM - 1 });
    const b = snapViewportForKey({ ...BASE_BBOX, zoom: DEFAULT_CLUSTER_DISABLE_ZOOM });
    expect(a).not.toEqual(b);
  });

  it('treats a missing zoom as band 0 (clustered), distinct from an explicit high zoom', () => {
    const a = snapViewportForKey({ ...BASE_BBOX });
    const b = snapViewportForKey({ ...BASE_BBOX, zoom: DEFAULT_CLUSTER_DISABLE_ZOOM });
    expect(a?.zoomBand).toBe('clustered');
    expect(b?.zoomBand).toBe('individual');
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
