// Pure cross-instance merge for scatter-gather top-K: merges the union of
// each instance's top rows and slices the requested page.

import { nearestLocationMeters, type LatLng } from './geo_distance.js';

export interface MergeableRow {
  item_locations: Array<{ lat: number; lng: number }>;
  created_at?: Date | string;
}

export interface MergeSortAndSliceOptions {
  /** Reference point for geo ordering, or `null` for recency-only ordering. */
  center: LatLng | null;
  offset: number;
  limit: number;
}

/** Epoch ms for a row's created_at, or -Infinity when missing (sorts oldest). */
function createdAtMillis(createdAt: Date | string | undefined): number {
  if (createdAt === undefined) return -Infinity;
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Merges per-instance rows into one ordered page.
 *
 * - `center` set and the order is distance: nearest first (no-location rows
 *   last), tie-broken by `created_at` descending.
 * - otherwise: `created_at` descending.
 *
 * `orderBy` exists because a centre is also present for a radius filter, so
 * the centre alone must not force a distance order. Omitted means infer from
 * `center`. Full ties keep their original order. Does not mutate `rows`.
 */
export function mergeSortAndSlice<T extends MergeableRow>(
  rows: T[],
  opts: {
    center: LatLng | null;
    offset: number;
    limit: number;
    orderBy?: 'distance' | 'created_at';
  }
): T[] {
  const { center, offset, limit } = opts;
  const byDistance = center !== null && opts.orderBy !== 'created_at';

  const decorated = rows.map((row, index) => ({ row, index }));

  decorated.sort((x, y) => {
    if (byDistance && center) {
      const dx = nearestLocationMeters(center, x.row.item_locations);
      const dy = nearestLocationMeters(center, y.row.item_locations);
      if (dx !== dy) return dx - dy;
    }

    const tx = createdAtMillis(x.row.created_at);
    const ty = createdAtMillis(y.row.created_at);
    if (tx !== ty) return ty - tx; // descending: newer first

    return x.index - y.index; // stable tie-break
  });

  return decorated.slice(offset, offset + limit).map((d) => d.row);
}
