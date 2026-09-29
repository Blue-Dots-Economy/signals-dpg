import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/node';
import { humanizeKey } from './columns';
import { wallClockInZone, zoneHeading } from './time';

/**
 * Excel workbook of an engagement export (#770). One sheet, headings in plain
 * words (the labels `buildExport` resolved from the schema), typed cells:
 *
 * - text stays text — a phone number keeps its leading zero, and a value
 *   such as `=cmd` is stored as a string, never evaluated as a formula;
 * - dates are real dates in EXPORT_TIMEZONE, the zone named in the heading;
 * - the match score is a percentage, the "shared" flag reads Yes / No;
 * - lists are joined with `, ` as the UI shows them.
 */

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Fixed columns whose values are keys (`accepted`, `received`, `seeker`);
// the file shows them the way the page does.
const HUMANISED_VALUES = new Set(['action_type', 'action_status', 'direction', 'counterparty_domain']);
const DATE_COLUMNS = new Set(['created_at', 'updated_at']);
const DATE_FORMAT = 'dd mmm yyyy, hh:mm AM/PM';
const MIN_WIDTH = 10;
const MAX_WIDTH = 50;
// Excel's own limit, and characters it refuses in a sheet name.
const SHEET_NAME_MAX = 31;
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/g;

export interface ExportWorkbookInput {
  /** Column keys, as `buildExport` returns them. */
  header: readonly string[];
  /** Heading per column, in `header` order. */
  labels: readonly string[];
  records: readonly (readonly unknown[])[];
  /** Tab name, e.g. the counterparty role ("Seekers"). */
  sheetName: string;
  /** IANA zone the dates are shown in (EXPORT_TIMEZONE). */
  timeZone: string;
  now: Date;
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Any profile value as a typed cell; objects fall back to JSON text. */
function valueCell(value: unknown): Cell {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return { value, type: String };
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value) && value.every(isPrimitive)) {
    return value.length > 0 ? { value: value.map(String).join(', '), type: String } : null;
  }
  return { value: JSON.stringify(value), type: String };
}

function cellFor(key: string, value: unknown, timeZone: string): Cell {
  if (DATE_COLUMNS.has(key)) {
    const d = toDate(value);
    return d ? { value: wallClockInZone(d, timeZone), type: Date, format: DATE_FORMAT } : null;
  }
  if (key === 'match_score') {
    // Scores are 0–10; the page shows 7.5 as 75%.
    return typeof value === 'number' ? { value: value / 10, type: Number, format: '0%' } : null;
  }
  if (HUMANISED_VALUES.has(key) && typeof value === 'string') {
    return { value: humanizeKey(value), type: String };
  }
  return valueCell(value);
}

/** Approximate displayed text of a cell, for sizing its column. */
function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  const value: unknown = typeof cell === 'object' && 'value' in cell ? cell.value : cell;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return DATE_FORMAT;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** A tab name Excel accepts: no `[]:*?/\`, at most 31 characters. */
export function safeSheetName(name: string): string {
  const clean = name.replaceAll(SHEET_NAME_FORBIDDEN, ' ').trim().slice(0, SHEET_NAME_MAX).trim();
  return clean || 'Export';
}

/** Builds the workbook; resolves to the file bytes. */
export async function buildExportWorkbook(input: ExportWorkbookInput): Promise<Buffer> {
  const zone = zoneHeading(input.now, input.timeZone);
  const headings = input.header.map((key, i) => {
    const label = input.labels[i] ?? humanizeKey(key);
    return DATE_COLUMNS.has(key) ? `${label} (${zone})` : label;
  });

  const rows: SheetData = [
    headings.map((h) => ({ value: h, type: String, fontWeight: 'bold' as const })),
    ...input.records.map((rec) => input.header.map((key, i) => cellFor(key, rec[i], input.timeZone))),
  ];

  // Fit each column to its longest cell, within sensible bounds.
  const columns = input.header.map((_, i) => ({
    width: Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, ...rows.map((r) => cellText(r[i]).length + 2)),
    ),
  }));

  return writeXlsxFile(rows, {
    sheet: safeSheetName(input.sheetName),
    columns,
    stickyRowsCount: 1,
  }).toBuffer();
}
