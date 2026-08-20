// RJSF form rendering requires jsdom (happy-dom lacks form submission support
// and some RJSF internals depend on document.createEvent which jsdom provides).
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { RJSFSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import { isSchemaFormValid, SchemaForm } from '../schema-form';

const nameSchema: RJSFSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
  },
};

describe('isSchemaFormValid (pure helper)', () => {
  it('returns false when required field is missing', () => {
    expect(isSchemaFormValid(validator, nameSchema, {})).toBe(false);
  });

  it('returns false when required string is empty', () => {
    expect(isSchemaFormValid(validator, nameSchema, { name: '' })).toBe(false);
  });

  it('returns true when required field is satisfied', () => {
    expect(isSchemaFormValid(validator, nameSchema, { name: 'x' })).toBe(true);
  });
});

describe('SchemaForm hideSubmit prop', () => {
  it('renders no submit button when hideSubmit is true', () => {
    render(
      <SchemaForm schema={nameSchema} onSubmit={vi.fn()} hideSubmit />,
    );
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('renders a submit button when hideSubmit is false (default)', () => {
    render(
      <SchemaForm schema={nameSchema} onSubmit={vi.fn()} submitButtonText="Save" />,
    );
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });
});

describe('SchemaForm onValidityChange prop', () => {
  it('calls onValidityChange(false) on mount when required fields are empty', async () => {
    const onValidityChange = vi.fn();
    render(
      <SchemaForm
        schema={nameSchema}
        onSubmit={vi.fn()}
        onValidityChange={onValidityChange}
      />,
    );
    await waitFor(() => {
      // The boolean is still the first argument; a second argument now carries
      // WHY it is invalid (see SchemaFormValidity).
      expect(onValidityChange).toHaveBeenCalledWith(
        false,
        expect.objectContaining({ valid: false, missingRequired: 1 }),
      );
    });
  });

  it('calls onValidityChange(true) on mount when required fields are satisfied', async () => {
    const onValidityChange = vi.fn();
    render(
      <SchemaForm
        schema={nameSchema}
        formData={{ name: 'Alice' }}
        onSubmit={vi.fn()}
        onValidityChange={onValidityChange}
      />,
    );
    await waitFor(() => {
      expect(onValidityChange).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ valid: true, missingRequired: 0, invalidValues: 0 }),
      );
    });
  });

  it('does not call onValidityChange when prop is not provided', async () => {
    // Render without the prop — should not throw and should still render.
    const { container } = render(
      <SchemaForm schema={nameSchema} onSubmit={vi.fn()} />,
    );
    expect(container).toBeTruthy();
  });
});
