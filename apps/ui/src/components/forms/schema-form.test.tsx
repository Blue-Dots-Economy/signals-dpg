// RJSF v6's form submit does not fire under happy-dom (the suite default); jsdom
// implements form submission, so this file overrides the environment per-file.
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm } from './schema-form';

// educationCategory controls schoolQualification; `note` is always visible.
const schema = {
  type: 'object',
  required: ['educationCategory', 'schoolQualification'],
  properties: {
    educationCategory: { type: 'string', title: 'Education', enum: ['School', 'College'] },
    schoolQualification: {
      type: 'string',
      title: 'School Qualification',
      enum: ['10th', '12th'],
      'x-show-if': { educationCategory: ['School'] },
    },
    note: { type: 'string', title: 'Note' },
  },
} as RJSFSchema;

describe('SchemaForm + x-show-if', () => {
  it('hides a conditional field when its control does not match', () => {
    render(
      <SchemaForm schema={schema} formData={{ educationCategory: 'College' }} onSubmit={vi.fn()} />,
    );
    expect(screen.queryByText(/School Qualification/)).not.toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
  });

  it('shows a conditional field when its control matches', () => {
    render(
      <SchemaForm schema={schema} formData={{ educationCategory: 'School' }} onSubmit={vi.fn()} />,
    );
    expect(screen.getByText(/School Qualification/)).toBeInTheDocument();
  });

  it('does not submit a hidden field value (clear-on-hide guarantee)', async () => {
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ educationCategory: 'College', schoolQualification: '10th' }}
        onSubmit={onSubmit}
        submitButtonText="Save"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('schoolQualification');
    expect(payload).toMatchObject({ educationCategory: 'College' });
  });

  it('keeps focus while typing in a visible field (no remount)', async () => {
    render(
      <SchemaForm schema={schema} formData={{ educationCategory: 'School' }} onSubmit={vi.fn()} />,
    );
    const noteInput = screen.getByLabelText('Note') as HTMLInputElement;
    await userEvent.type(noteInput, 'hello');
    expect(noteInput).toHaveValue('hello');
    expect(document.activeElement).toBe(noteInput);
    // The conditional field stays visible — typing a non-control field must not re-prune.
    expect(screen.getByText(/School Qualification/)).toBeInTheDocument();
  });
});
