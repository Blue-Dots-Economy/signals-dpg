import { describe, it, expect } from 'vitest';
import { mergeSortAndSlice } from '../instance_merge.js';

interface Row {
  id: string;
  item_locations: Array<{ lat: number; lng: number }>;
  created_at?: Date | string;
}

function row(
  id: string,
  locations: Array<{ lat: number; lng: number }>,
  createdAt?: Date | string
): Row {
  return { id, item_locations: locations, created_at: createdAt };
}

describe('mergeSortAndSlice — geo mode (center set)', () => {
  it('orders a shuffled union nearest-first', () => {
    const center = { lat: 0, lng: 0 };
    const near = row('near', [{ lat: 0.001, lng: 0 }], '2024-01-01T00:00:00Z'); // ~111m
    const mid = row('mid', [{ lat: 0.01, lng: 0 }], '2024-01-01T00:00:00Z'); // ~1113m
    const far = row('far', [{ lat: 1, lng: 0 }], '2024-01-01T00:00:00Z'); // ~111km

    // Shuffled input union from multiple instances.
    const shuffled = [far, near, mid];
    const result = mergeSortAndSlice(shuffled, {
      center,
      offset: 0,
      limit: 10,
    });

    expect(result.map((r) => r.id)).toEqual(['near', 'mid', 'far']);
  });

  it('sorts no-location rows last regardless of shuffle position', () => {
    const center = { lat: 0, lng: 0 };
    const withLoc = row('with-loc', [{ lat: 0.001, lng: 0 }], '2024-01-01T00:00:00Z');
    const noLoc = row('no-loc', [], '2024-06-01T00:00:00Z'); // newer, but no location

    const result = mergeSortAndSlice([noLoc, withLoc], {
      center,
      offset: 0,
      limit: 10,
    });

    expect(result.map((r) => r.id)).toEqual(['with-loc', 'no-loc']);
  });

  it('tie-breaks equal distances by created_at descending (newer first)', () => {
    const center = { lat: 0, lng: 0 };
    // Both exactly the same distance from center.
    const older = row('older', [{ lat: 0.005, lng: 0 }], '2024-01-01T00:00:00Z');
    const newer = row('newer', [{ lat: 0.005, lng: 0 }], '2024-06-01T00:00:00Z');

    const result = mergeSortAndSlice([older, newer], {
      center,
      offset: 0,
      limit: 10,
    });

    expect(result.map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('treats missing created_at as oldest when tie-breaking', () => {
    const center = { lat: 0, lng: 0 };
    const sameDistance = { lat: 0.005, lng: 0 };
    const withDate = row('with-date', [sameDistance], '2024-01-01T00:00:00Z');
    const noDate = row('no-date', [sameDistance], undefined);

    const result = mergeSortAndSlice([noDate, withDate], {
      center,
      offset: 0,
      limit: 10,
    });

    expect(result.map((r) => r.id)).toEqual(['with-date', 'no-date']);
  });

  it('is stable for fully equal keys (same distance, same created_at)', () => {
    const center = { lat: 0, lng: 0 };
    const sameDistance = { lat: 0.005, lng: 0 };
    const sameDate = '2024-01-01T00:00:00Z';
    const a = row('a', [sameDistance], sameDate);
    const b = row('b', [sameDistance], sameDate);
    const c = row('c', [sameDistance], sameDate);

    const result = mergeSortAndSlice([a, b, c], {
      center,
      offset: 0,
      limit: 10,
    });

    // Original relative order preserved for fully-tied rows.
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeSortAndSlice — non-geo mode (center null)', () => {
  it('orders by created_at descending only', () => {
    const a = row('a', [], '2024-01-01T00:00:00Z');
    const b = row('b', [], '2024-06-01T00:00:00Z');
    const c = row('c', [], '2024-03-01T00:00:00Z');

    const result = mergeSortAndSlice([a, b, c], {
      center: null,
      offset: 0,
      limit: 10,
    });

    expect(result.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('treats missing created_at as oldest', () => {
    const withDate = row('with-date', [], '2024-01-01T00:00:00Z');
    const noDate = row('no-date', [], undefined);

    const result = mergeSortAndSlice([noDate, withDate], {
      center: null,
      offset: 0,
      limit: 10,
    });

    expect(result.map((r) => r.id)).toEqual(['with-date', 'no-date']);
  });

  it('accepts Date objects as well as ISO strings for created_at', () => {
    const a = row('a', [], new Date('2024-01-01T00:00:00Z'));
    const b = row('b', [], new Date('2024-06-01T00:00:00Z'));

    const result = mergeSortAndSlice([a, b], {
      center: null,
      offset: 0,
      limit: 10,
    });

    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('mergeSortAndSlice — offset/limit slicing', () => {
  const rows = [
    row('a', [], '2024-05-01T00:00:00Z'),
    row('b', [], '2024-04-01T00:00:00Z'),
    row('c', [], '2024-03-01T00:00:00Z'),
    row('d', [], '2024-02-01T00:00:00Z'),
    row('e', [], '2024-01-01T00:00:00Z'),
  ];

  it('respects limit', () => {
    const result = mergeSortAndSlice(rows, { center: null, offset: 0, limit: 2 });
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('respects offset', () => {
    const result = mergeSortAndSlice(rows, { center: null, offset: 2, limit: 2 });
    expect(result.map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('returns [] when offset is beyond the rows length', () => {
    const result = mergeSortAndSlice(rows, { center: null, offset: 100, limit: 10 });
    expect(result).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    mergeSortAndSlice(rows, { center: null, offset: 0, limit: 2 });
    expect(rows).toEqual(copy);
  });
});
