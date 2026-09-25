import { describe, it, expect } from 'vitest';
import { buildExportFilename } from '../filename';

const now = new Date('2026-09-24T10:15:00.123Z');
const exportId = '3f9a1c2e-1111-4000-8000-000000000000';

describe('buildExportFilename', () => {
  it('network_domain_status_exportid8_ts.csv, UTC, no colons', () => {
    expect(
      buildExportFilename({
        network: 'purple_dot',
        counterpartyDomain: 'seeker',
        statuses: ['accepted'],
        exportId,
        now,
        timeZone: 'UTC',
      })
    ).toBe('purple_dot_seeker_accepted_3f9a1c2e_2026-09-24T10-15-00Z.csv');
  });

  it('joins several statuses and uses "all" when unfiltered', () => {
    const base = { network: 'n', counterpartyDomain: 'd', exportId, now, timeZone: 'UTC' };
    expect(buildExportFilename({ ...base, statuses: ['accepted', 'completed'] })).toContain(
      '_accepted-completed_'
    );
    expect(buildExportFilename({ ...base, statuses: undefined })).toContain('_all_');
  });

  it('falls back when no counterparty type was resolved (empty export)', () => {
    expect(
      buildExportFilename({ network: undefined, counterpartyDomain: undefined, statuses: [], exportId, now, timeZone: 'UTC' })
    ).toBe('export_none_all_3f9a1c2e_2026-09-24T10-15-00Z.csv');
  });

  it('strips anything outside [A-Za-z0-9_-] from each part', () => {
    expect(
      buildExportFilename({
        network: 'a/b',
        counterpartyDomain: 'c"d',
        statuses: ['x y'],
        exportId,
        now,
        timeZone: 'UTC',
      })
    ).toBe('a-b_c-d_x-y_3f9a1c2e_2026-09-24T10-15-00Z.csv');
  });

  it('uses EXPORT_TIMEZONE with a compact offset (IST)', () => {
    expect(
      buildExportFilename({
        network: 'blue_dot',
        counterpartyDomain: 'seeker',
        statuses: ['accepted', 'completed'],
        exportId,
        now,
        timeZone: 'Asia/Kolkata',
      })
    ).toBe('blue_dot_seeker_accepted-completed_3f9a1c2e_2026-09-24T15-45-00+0530.csv');
  });
});
