import { describe, expect, it } from 'vitest';
import type { MapMarker } from '@/engine/types';
import { spreadCoLocatedMarkers } from './map-container';

function marker(id: string, lat: number, lng: number): MapMarker {
  return {
    id,
    lat,
    lng,
    label: id,
    data: {},
    precision: 'exact',
  };
}

// A shared coordinate used across tests — the viewer's "You" self-marker.
const SELF = { lat: 12.9716, lng: 77.5946 };

describe('spreadCoLocatedMarkers (#394 — self-location awareness)', () => {
  it('offsets a single item sitting exactly on the self location off that point', () => {
    const items = [marker('item-1', SELF.lat, SELF.lng)];

    const [result] = spreadCoLocatedMarkers(items, SELF);

    expect(result.lat).not.toBe(SELF.lat);
    expect(result.lng).not.toBe(SELF.lng);
  });

  it('leaves a lone item NOT at the self location unchanged', () => {
    const items = [marker('item-1', 10.0, 20.0)];

    const result = spreadCoLocatedMarkers(items, SELF);

    expect(result).toEqual(items);
  });

  it('still fans out 2+ items co-located with each other (unaffected by self-location)', () => {
    const items = [marker('item-1', 10.0, 20.0), marker('item-2', 10.0, 20.0)];

    const result = spreadCoLocatedMarkers(items, SELF);

    expect(result).toHaveLength(2);
    for (const m of result) {
      expect(m.lat === 10.0 && m.lng === 20.0).toBe(false);
    }
    // The two must still be distinguishable from each other.
    const [a, b] = result;
    expect(a.lat === b.lat && a.lng === b.lng).toBe(false);
  });

  it('spreads items co-located with each other AND at the self point to distinct positions', () => {
    const items = [
      marker('item-1', SELF.lat, SELF.lng),
      marker('item-2', SELF.lat, SELF.lng),
    ];

    const result = spreadCoLocatedMarkers(items, SELF);

    expect(result).toHaveLength(2);
    const [a, b] = result;
    // Distinct from each other.
    expect(a.lat === b.lat && a.lng === b.lng).toBe(false);
    // Distinct from the self point.
    for (const m of result) {
      expect(m.lat === SELF.lat && m.lng === SELF.lng).toBe(false);
    }
  });

  it('behaves exactly as before when there is no self location', () => {
    const items = [marker('item-1', 10.0, 20.0), marker('item-2', 30.0, 40.0)];

    const result = spreadCoLocatedMarkers(items, null);

    expect(result).toEqual(items);
  });
});
