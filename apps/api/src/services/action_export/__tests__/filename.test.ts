import { describe, it, expect } from 'vitest';
import { buildExportFilename } from '../filename';

const now = new Date('2026-09-24T10:15:00.123Z');

describe('buildExportFilename', () => {
  it('network_domain_status_ts.xlsx, UTC, no colons', () => {
    expect(
      buildExportFilename({
        network: 'purple_dot',
        counterpartyDomain: 'seeker',
        statuses: ['accepted'],
        now,
        timeZone: 'UTC',
      })
    ).toBe('purple_dot_seeker_accepted_2026-09-24T10-15-00Z.xlsx');
  });

  it('joins several statuses and uses "all" when unfiltered', () => {
    const base = { network: 'n', counterpartyDomain: 'd', now, timeZone: 'UTC' };
    expect(buildExportFilename({ ...base, statuses: ['accepted', 'completed'] })).toContain(
      '_accepted-completed_'
    );
    expect(buildExportFilename({ ...base, statuses: undefined })).toContain('_all_');
  });

  it('falls back when no counterparty type was resolved (empty export)', () => {
    expect(
      buildExportFilename({ network: undefined, counterpartyDomain: undefined, statuses: [], now, timeZone: 'UTC' })
    ).toBe('export_none_all_2026-09-24T10-15-00Z.xlsx');
  });

  it('strips anything outside [A-Za-z0-9_-] from each part', () => {
    expect(
      buildExportFilename({
        network: 'a/b',
        counterpartyDomain: 'c"d',
        statuses: ['x y'],
        now,
        timeZone: 'UTC',
      })
    ).toBe('a-b_c-d_x-y_2026-09-24T10-15-00Z.xlsx');
  });

  it('uses EXPORT_TIMEZONE with a compact offset (IST)', () => {
    expect(
      buildExportFilename({
        network: 'blue_dot',
        counterpartyDomain: 'seeker',
        statuses: ['accepted', 'completed'],
        now,
        timeZone: 'Asia/Kolkata',
      })
    ).toBe('blue_dot_seeker_accepted-completed_2026-09-24T15-45-00+0530.xlsx');
  });
});
