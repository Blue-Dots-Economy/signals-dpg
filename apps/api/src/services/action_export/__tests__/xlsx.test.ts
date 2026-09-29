import { describe, it, expect } from 'vitest';
import readXlsxFile from 'read-excel-file/node';
import { buildExportWorkbook, safeSheetName } from '../xlsx';

const now = new Date('2026-09-29T10:00:00Z');

async function sheetOf(header: string[], labels: string[], records: unknown[][], timeZone = 'Asia/Kolkata') {
  const buf = await buildExportWorkbook({ header, labels, records, sheetName: 'Service Provider', timeZone, now });
  const [sheet] = await readXlsxFile(buf);
  return sheet;
}

describe('buildExportWorkbook', () => {
  it('writes plain-word headings, zone-named date headings, and typed cells', async () => {
    const sheet = await sheetOf(
      ['action_status', 'direction', 'created_at', 'pii_revealed', 'match_score', 'phone', 'langs', 'years'],
      ['Status', 'Direction', 'Created', 'Contact details shared', 'Match score', 'Mobile', 'Languages', 'Years'],
      [['accepted', 'received', new Date('2026-09-01T00:00:00Z'), true, 7.5, '0987654321', ['Hindi', 'English'], 3]]
    );
    expect(sheet.sheet).toBe('Service Provider');
    expect(sheet.data[0]).toEqual([
      'Status',
      'Direction',
      'Created (IST)',
      'Contact details shared',
      'Match score',
      'Mobile',
      'Languages',
      'Years',
    ]);
    const [status, dir, created, shared, score, phone, langs, years] = sheet.data[1];
    expect([status, dir, shared]).toEqual(['Accepted', 'Received', 'Yes']);
    // IST wall-clock time: 00:00Z is 05:30 in Kolkata.
    expect((created as unknown as Date).toISOString()).toBe('2026-09-01T05:30:00.000Z');
    expect(score).toBe(0.75);
    // Text stays text: the leading zero survives.
    expect(phone).toBe('0987654321');
    expect(langs).toBe('Hindi, English');
    expect(years).toBe(3);
  });

  it('stores formula-looking text as text, and empty values as empty cells', async () => {
    const sheet = await sheetOf(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      ['A', 'B', 'C', 'D', 'E', 'F'],
      [['=HYPERLINK("x")', null, '', [], { k: 1 }, false]],
      'UTC'
    );
    expect(sheet.data[1]).toEqual(['=HYPERLINK("x")', null, null, null, '{"k":1}', 'No']);
  });

  it('names date headings in the configured zone and humanises a missing label', async () => {
    const sheet = await sheetOf(['updated_at', 'some_key'], ['Updated'], [], 'UTC');
    expect(sheet.data[0]).toEqual(['Updated (UTC)', 'Some Key']);
  });

  it('leaves an unparseable date or a non-numeric score empty', async () => {
    const sheet = await sheetOf(
      ['created_at', 'match_score', 'id'],
      ['Created', 'Match score', 'ID'],
      [['not a date', null, 'a1']],
      'UTC'
    );
    expect(sheet.data[1]).toEqual([null, null, 'a1']);
  });
});

describe('safeSheetName', () => {
  it('drops characters Excel refuses and keeps within 31 characters', () => {
    expect(safeSheetName('a/b:c*d?e[f]')).toBe('a b c d e f');
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(safeSheetName(' / ')).toBe('Export');
  });
});
