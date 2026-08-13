import { describe, expect, it } from 'vitest';
import { maskPrivateState } from '../item_state_masking';

const schema = {
  type: 'object',
  properties: {
    issued_on: { type: 'string', format: 'date', private: true },
    last_seen_at: { type: 'string', format: 'date-time', private: true },
    portfolio: { type: 'string', format: 'uri', private: true },
    homepage: { type: 'string', format: 'url', private: true },
    // Array of plain strings — masked entry-by-entry with the parent key's rule.
    alt_emails: { type: 'array', items: { type: 'string', format: 'email' }, private: true },
    nicknames: { type: 'array', items: { type: 'string' }, private: true },
    // Array whose `items` is not an object schema, so entries fall through to maskLeaf.
    loose_list: { type: 'array', items: true, private: true },
  },
} as const;

describe('maskPrivateState format-driven rules', () => {
  it('replaces a date with the XXXX-XX-XX placeholder', () => {
    expect(maskPrivateState(schema, { issued_on: '2026-01-15' }).issued_on).toBe('XXXX-XX-XX');
  });

  it('replaces a date-time with the same placeholder (no time leaked)', () => {
    expect(maskPrivateState(schema, { last_seen_at: '2026-01-15T09:41:00Z' }).last_seen_at).toBe(
      'XXXX-XX-XX',
    );
  });

  it('keeps only the scheme of a uri', () => {
    expect(maskPrivateState(schema, { portfolio: 'https://asha.dev/work?ref=1' }).portfolio).toBe(
      'https://***',
    );
  });

  it('preserves a non-https scheme', () => {
    expect(maskPrivateState(schema, { homepage: 'ftp://files.example.com/cv' }).homepage).toBe(
      'ftp://***',
    );
  });

  it('falls back to https:// when the value carries no parseable scheme', () => {
    expect(maskPrivateState(schema, { homepage: 'asha.dev/work' }).homepage).toBe('https://***');
  });
});

describe('maskPrivateState arrays of scalars', () => {
  it('masks each string entry using the parent field rule', () => {
    const out = maskPrivateState(schema, { alt_emails: ['a@x.com', 'bee@y.org'] });
    // items.format=email is not consulted — the parent propSchema (an array with
    // no `format`) is what maskLeaf sees, so the generic fallback applies.
    expect(out.alt_emails).toEqual(['a***', 'b***']);
  });

  it('masks entries of an untyped array with the first-char fallback', () => {
    expect(maskPrivateState(schema, { nicknames: ['Ashu', 'Ash'] }).nicknames).toEqual([
      'A***',
      'A***',
    ]);
  });

  it('passes null and undefined array entries through unchanged', () => {
    const out = maskPrivateState(schema, { nicknames: ['Ashu', null, undefined] });
    expect(out.nicknames).toEqual(['A***', null, undefined]);
  });

  it('masks object entries as leaves when items is not an object schema', () => {
    const out = maskPrivateState(schema, { loose_list: [{ a: 1 }] });
    expect(out.loose_list).toEqual(['[***']);
  });

  it('leaves an array alone when the field is absent from the schema properties', () => {
    const out = maskPrivateState({ type: 'object' }, { unknown_list: ['zebra'] });
    expect(out.unknown_list).toEqual(['z***']);
  });

  it('emits only the keys present in the input state, preserving an empty array', () => {
    const out = maskPrivateState(schema, { nicknames: [] });
    expect(Object.keys(out)).toEqual(['nicknames']);
    expect(out.nicknames).toEqual([]);
  });
});
