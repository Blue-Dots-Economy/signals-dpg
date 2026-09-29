/**
 * Timestamps for the engagement export (#771) in the deployment's configured
 * zone (`EXPORT_TIMEZONE`). The filename and the generated-at header carry
 * their offset (`Z` or `±HH:MM`); the file's date cells are wall-clock times
 * in the zone, which their heading names (`zoneHeading`). Uses Intl — no date
 * library — and follows daylight saving.
 */

// One check for config (EXPORT_TIMEZONE) and here.
export { isValidTimeZone } from '@dpg/config';

interface ZonedParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  offsetMinutes: number;
}

function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const wholeSeconds = Math.floor(at.getTime() / 1000) * 1000;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    offsetMinutes: Math.round((wallAsUtc - wholeSeconds) / 60_000),
  };
}

function offsetSuffix(minutes: number, separator: string): string {
  if (minutes === 0) return 'Z';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}${separator}${mm}`;
}

/** ISO-8601 in `timeZone`, second precision: `2026-09-25T12:09:43+05:30`. */
export function formatIsoInZone(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.date}T${p.time}${offsetSuffix(p.offsetMinutes, ':')}`;
}

/** Filename-safe stamp (no `:`): `2026-09-25T12-09-43+0530`. */
export function filenameStamp(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.date}T${p.time.replaceAll(':', '-')}${offsetSuffix(p.offsetMinutes, '')}`;
}

/**
 * `at` shifted so its UTC fields read as the wall-clock time in `timeZone`.
 * Spreadsheet dates carry no zone, and the xlsx writer takes a Date's UTC
 * fields, so this is how a cell shows 15:53 for 10:23Z in Asia/Kolkata.
 */
export function wallClockInZone(at: Date, timeZone: string): Date {
  return new Date(at.getTime() + zonedParts(at, timeZone).offsetMinutes * 60_000);
}

/**
 * The zone name for a date column heading. One heading covers every row, so
 * a zone with daylight saving is named by its IANA id (`Europe/London`) — a
 * short name taken from one moment (`BST`) would mislabel the other half of
 * the year. A fixed-offset zone keeps its short name (`IST`, `UTC`).
 */
export function zoneHeading(at: Date, timeZone: string): string {
  const year = at.getUTCFullYear();
  const winter = zonedParts(new Date(Date.UTC(year, 0, 1)), timeZone).offsetMinutes;
  const summer = zonedParts(new Date(Date.UTC(year, 6, 1)), timeZone).offsetMinutes;
  return winter === summer ? zoneAbbreviation(at, timeZone) : timeZone;
}

/** Short zone name at `at`: `IST`, `UTC`, or `GMT+x`. */
export function zoneAbbreviation(at: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-IN', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  return name ?? timeZone;
}
