// RJSF v6's form submit does not fire under happy-dom (the suite default); jsdom
// implements form submission, so this file overrides the environment per-file.
// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi } from 'vitest';
import validator from '@rjsf/validator-ajv8';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm, isSchemaFormValid } from '../schema-form';
import { applyUriPatterns } from '@dpg/schemas/uri_fields';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

// jsdom does not implement Element.prototype.scrollIntoView, which the form's
// focusOnFirstError handler calls on a blocked submit. Without this stub RJSF's
// submit handler throws before it can render the error, so the blocked-submit
// case below could never observe the message.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    site: { type: 'string', title: 'Site', 'x-uri': true },
  },
} as RJSFSchema;

describe('applyUriPatterns + the RJSF validator', () => {
  // RJSF's ajv also runs strict:false, so the injected `pattern` is what bites;
  // the marker itself is inert. These cases pin the rule the form enforces.
  const patched = applyUriPatterns(schema);

  it('rejects a non-URL value in a marked field', () => {
    expect(isSchemaFormValid(validator, patched, { site: 'companyabc' })).toBe(false);
  });

  it('accepts a scheme-less host, a full URL, and an empty value', () => {
    expect(isSchemaFormValid(validator, patched, { site: 'example.com' })).toBe(true);
    expect(isSchemaFormValid(validator, patched, { site: 'https://example.com/x' })).toBe(true);
    expect(isSchemaFormValid(validator, patched, { site: '' })).toBe(true);
  });

  it('leaves unmarked fields unconstrained', () => {
    expect(isSchemaFormValid(validator, patched, { name: 'companyabc' })).toBe(true);
  });
});

describe('SchemaForm with an x-uri field', () => {
  it('blocks submit and shows a readable message for a non-URL value', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ name: 'Asha', site: 'companyabc' }}
        onSubmit={onSubmit}
        submitButtonText="Save"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Enter a valid link/i)).toBeInTheDocument();
    expect(screen.queryByText(/must match pattern/i)).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a scheme-less host unchanged', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ name: 'Asha', site: 'example.com' }}
        onSubmit={onSubmit}
        submitButtonText="Save"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ site: 'example.com' }));
  });

  it('uses the URL placeholder on the marked field', () => {
    render(<SchemaForm schema={schema} formData={{}} onSubmit={vi.fn()} submitButtonText="Save" />);
    expect(screen.getByLabelText(/Site/)).toHaveAttribute('placeholder', 'https://example.com');
  });
});
