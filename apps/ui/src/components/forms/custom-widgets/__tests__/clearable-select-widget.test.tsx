/**
 * Tests for the clear affordance on single-value enum fields.
 *
 * Driven through `SchemaForm` rather than by rendering the widget directly:
 * the point of the widget is that RJSF routes every enum field to it and that
 * clearing actually removes the key from the submitted data, and neither is
 * observable from the widget in isolation.
 *
 * jsdom, not the suite's default happy-dom — RJSF v6's form submit does not
 * fire under happy-dom (same reason `schema-form.test.tsx` overrides it).
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm } from '../../schema-form';

const CLEAR = 'Clear selection';

const schema = {
  type: 'object',
  required: ['fruit'],
  properties: {
    fruit: { type: 'string', title: 'Fruit', enum: ['apple', 'banana'] },
    gender: { type: 'string', title: 'Gender', enum: ['male', 'female'] },
    tags: {
      type: 'array',
      title: 'Tags',
      items: { type: 'string', enum: ['a', 'b'] },
      uniqueItems: true,
    },
  },
} as RJSFSchema;

describe('clearable enum fields', () => {
  it('clears an optional field back out of the submitted data', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ fruit: 'apple', gender: 'male' }}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: CLEAR }));
    await user.click(screen.getByRole('button', { name: /save|submit/i }));

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    // The key is gone, not set to an empty string — that is what "not
    // answered" means to everything downstream.
    expect('gender' in submitted).toBe(false);
    // ...and only the field that was cleared.
    expect(submitted.fruit).toBe('apple');
  });

  it('offers no clear button on a required field, however it is filled', () => {
    render(
      <SchemaForm schema={schema} formData={{ fruit: 'apple', gender: 'male' }} onSubmit={vi.fn()} />,
    );
    // One button only — `gender`'s. `fruit` is required, so emptying it is not
    // a state it may hold and the button would invite an error, not a choice.
    expect(screen.getAllByRole('button', { name: CLEAR })).toHaveLength(1);
  });

  it('offers no clear button on an empty field — there is nothing to clear', () => {
    render(<SchemaForm schema={schema} formData={{ fruit: 'apple' }} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('offers no clear button when the form is disabled', () => {
    render(
      <SchemaForm
        schema={schema}
        formData={{ fruit: 'apple', gender: 'male' }}
        onSubmit={vi.fn()}
        disabled
      />,
    );
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('leaves array-of-enum fields alone — their chips are already removable', () => {
    render(
      <SchemaForm
        schema={schema}
        formData={{ fruit: 'apple', tags: ['a'] }}
        onSubmit={vi.fn()}
      />,
    );
    // `tags` holds a value and is optional, but multi-selects route to
    // FancyMultiSelect and must fall through untouched.
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('still renders the field and its options after clearing', async () => {
    const user = userEvent.setup();
    render(
      <SchemaForm schema={schema} formData={{ fruit: 'apple', gender: 'male' }} onSubmit={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: CLEAR }));

    // The placeholder is back and the dropdown still works, so the field is
    // re-answerable rather than merely emptied.
    expect(screen.getByText('Select...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });
});
