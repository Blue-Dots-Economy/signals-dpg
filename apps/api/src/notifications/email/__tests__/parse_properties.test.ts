import { describe, expect, it } from 'vitest';
import { parseProperties } from '../parse_properties';

describe('parseProperties', () => {
  it('parses key=value lines, trimming key and value', () => {
    const { entries } = parseProperties('a.b=hello\n  c.d  =  world  \n');
    expect(entries.get('a.b')).toBe('hello');
    expect(entries.get('c.d')).toBe('world');
  });

  it('splits at the FIRST = so values may contain =', () => {
    const { entries } = parseProperties('k=a=b=c');
    expect(entries.get('k')).toBe('a=b=c');
  });

  it('skips blank lines and # / ! comments', () => {
    const { entries, malformedLines } = parseProperties(
      '# comment\n! also comment\n\n   \nkey=v\n',
    );
    expect(entries.size).toBe(1);
    expect(malformedLines).toEqual([]);
  });

  it('records 1-based malformed (no =) line numbers and skips them', () => {
    const { entries, malformedLines } = parseProperties('good=1\nbadline\nalso=2\n');
    expect(malformedLines).toEqual([2]);
    expect(entries.size).toBe(2);
  });

  it('keeps inline HTML and {{tokens}} in values untouched', () => {
    const { entries } = parseProperties(
      'b=<p>{{name}} has <b>bold</b> — and ‘quotes’</p>',
    );
    expect(entries.get('b')).toBe('<p>{{name}} has <b>bold</b> — and ‘quotes’</p>');
  });

  it('last duplicate key wins', () => {
    const { entries } = parseProperties('k=first\nk=second');
    expect(entries.get('k')).toBe('second');
  });
});
