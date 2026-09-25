import { describe, it, expect } from 'vitest';
import { csvCell, csvLine } from '../csv';

describe('csvCell', () => {
  it('renders empty for null / undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('renders primitives and dates', () => {
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-5)).toBe('-5'); // numbers are data, not formulas
    expect(csvCell(true)).toBe('true');
    expect(csvCell(new Date('2026-09-24T10:15:00.000Z'))).toBe('2026-09-24T10:15:00.000Z');
  });

  it('joins primitive arrays with a pipe', () => {
    expect(csvCell(['Aadhaar', 'Bank Account'])).toBe('Aadhaar|Bank Account');
  });

  it('JSON-encodes arrays of objects and stray objects', () => {
    expect(csvCell([{ a: 1 }])).toBe('"[{""a"":1}]"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('quotes cells containing a comma, quote, CR or LF', () => {
    expect(csvCell('Kanpur, UP')).toBe('"Kanpur, UP"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it.each(['=SUM(A1)', '+91 98765', '-1+2', '@cmd', '\tx', '\rx'])(
    'neutralises formula-leading string %j',
    (v) => {
      expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true);
    }
  );

  it('neutralises a joined array whose first value is a formula', () => {
    expect(csvCell(['=1', 'b'])).toBe("'=1|b");
  });
});

describe('csvLine', () => {
  it('joins cells with commas and ends with CRLF', () => {
    expect(csvLine(['a', 'b, c', null])).toBe('a,"b, c",\r\n');
  });
});
