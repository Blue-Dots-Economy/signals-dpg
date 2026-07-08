import { describe, it, expect } from 'vitest';
import { jitterPrivateLocations, sameLocations } from '../item_service';

/**
 * Locks in the "drift-free on re-save" property that `updateItemInternal`
 * (item_service.ts) relies on: echoed coords keep the stored (already
 * jittered) value, and a changed address is re-geocoded then re-jittered
 * deterministically rather than drifting on every save.
 *
 * This exercises the real building blocks the update branch composes
 * (`jitterPrivateLocations` / `jitterCoordinate` via it / `sameLocations`)
 * rather than `updateItemInternal` itself: that function is only ever
 * mocked in this repo's unit tests, and driving its real body needs a live
 * DB (`docker compose up -d db redis` for the integration suite), which is
 * unavailable in this environment. The branch wiring itself (lines ~421-441
 * of item_service.ts) is exercised by the integration suite when run with a
 * DB.
 */

const privateSchema = {
  properties: { address: { type: 'string', location: 'primary', private: true } },
};

const EXACT = { lat: 12.9716, lng: 77.5946 };
const EXACT_2 = { lat: 13.0827, lng: 80.2707 };

describe('location drift property (update path building blocks)', () => {
  it('is deterministic / no drift: jittering the same exact coord twice yields the identical point', () => {
    const first = jitterPrivateLocations([EXACT], privateSchema);
    const second = jitterPrivateLocations([EXACT], privateSchema);
    expect(first).toEqual(second);
  });

  it('echo preserved: sameLocations([J], [J]) is true, so the provided-coords branch keeps the stored value', () => {
    const J = jitterPrivateLocations([EXACT], privateSchema)[0];
    expect(sameLocations([J], [J])).toBe(true);
  });

  it('new coord re-jitters: a different exact coord produces a different point and falls through to jitter', () => {
    const J = jitterPrivateLocations([EXACT], privateSchema)[0];
    const JPrime = jitterPrivateLocations([EXACT_2], privateSchema)[0];
    expect(J).not.toEqual(JPrime);
    expect(sameLocations([EXACT_2], [J])).toBe(false);
  });
});
