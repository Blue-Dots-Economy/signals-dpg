import { describe, it, expect, vi } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { isFieldVisible, collectControlFields, resolveVisibleSchema } from './show-if';

// A small schema mirroring the real blue_dot chain:
// educationCategory -> schoolQualification -> schoolQualificationOther
function chainSchema(): RJSFSchema {
  return {
    type: 'object',
    required: ['educationCategory'],
    properties: {
      educationCategory: { type: 'string', enum: ['School', 'College', 'None'] },
      schoolQualification: {
        type: 'string',
        enum: ['10th', '12th', 'Other'],
        'x-show-if': { educationCategory: ['School'] },
      },
      schoolQualificationOther: {
        type: 'string',
        'x-show-if': { schoolQualification: ['Other'] },
      },
      note: { type: 'string' },
    },
  } as RJSFSchema;
}

describe('isFieldVisible', () => {
  it('is always visible when there is no x-show-if', () => {
    expect(isFieldVisible({ type: 'string' }, {})).toBe(true);
  });

  it('matches a scalar control value in the allowed list', () => {
    const field = { 'x-show-if': { educationCategory: ['School'] } };
    expect(isFieldVisible(field, { educationCategory: 'School' })).toBe(true);
    expect(isFieldVisible(field, { educationCategory: 'College' })).toBe(false);
  });

  it('treats a missing/empty control value as no match', () => {
    const field = { 'x-show-if': { educationCategory: ['School'] } };
    expect(isFieldVisible(field, {})).toBe(false);
    expect(isFieldVisible(field, { educationCategory: '' })).toBe(false);
  });

  it('matches when a multi-select control intersects the allowed list', () => {
    const field = { 'x-show-if': { skills: ['welding'] } };
    expect(isFieldVisible(field, { skills: ['welding', 'plumbing'] })).toBe(true);
    expect(isFieldVisible(field, { skills: ['plumbing'] })).toBe(false);
    expect(isFieldVisible(field, { skills: [] })).toBe(false);
  });

  it('ANDs multiple control keys', () => {
    const field = { 'x-show-if': { a: ['x'], b: ['y'] } };
    expect(isFieldVisible(field, { a: 'x', b: 'y' })).toBe(true);
    expect(isFieldVisible(field, { a: 'x', b: 'z' })).toBe(false);
  });
});

describe('collectControlFields', () => {
  it('returns every control field referenced by any x-show-if', () => {
    const set = collectControlFields(chainSchema());
    expect([...set].sort()).toEqual(['educationCategory', 'schoolQualification']);
  });
});

describe('resolveVisibleSchema', () => {
  it('keeps all fields visible when controls match (no pruning)', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'School',
      schoolQualification: 'Other',
      schoolQualificationOther: 'Diploma',
    });
    expect(hidden).toEqual([]);
    expect(Object.keys(schema.properties ?? {})).toContain('schoolQualificationOther');
    expect(formData.schoolQualificationOther).toBe('Diploma');
  });

  it('hides a dependent and clears its value when the control does not match', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'College',
      schoolQualification: '10th',
    });
    expect(hidden).toContain('schoolQualification');
    expect(schema.properties).not.toHaveProperty('schoolQualification');
    expect(formData).not.toHaveProperty('schoolQualification');
  });

  it('cascades chains: hiding a control also hides and clears its grandchild', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'College', // hides schoolQualification ...
      schoolQualification: 'Other', // ... which was the control for the grandchild
      schoolQualificationOther: 'Diploma',
    });
    expect(hidden).toEqual(
      expect.arrayContaining(['schoolQualification', 'schoolQualificationOther']),
    );
    expect(formData).not.toHaveProperty('schoolQualificationOther');
    expect(schema.properties).not.toHaveProperty('schoolQualificationOther');
  });

  it('removes hidden fields from required', () => {
    const base = chainSchema();
    base.required = ['educationCategory', 'schoolQualification'];
    const { schema } = resolveVisibleSchema(base, { educationCategory: 'College' });
    expect(schema.required).toEqual(['educationCategory']);
  });

  it('does not mutate the input schema or formData', () => {
    const base = chainSchema();
    const input = { educationCategory: 'College', schoolQualification: '10th' };
    resolveVisibleSchema(base, input);
    expect(input).toHaveProperty('schoolQualification'); // input untouched
    expect(base.properties).toHaveProperty('schoolQualification');
  });

  it('warns in dev when an x-show-if references an unknown control field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        b: { type: 'string', 'x-show-if': { doesNotExist: ['x'] } },
      },
    } as RJSFSchema;
    resolveVisibleSchema(schema, {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('doesNotExist'));
    warn.mockRestore();
  });
});
