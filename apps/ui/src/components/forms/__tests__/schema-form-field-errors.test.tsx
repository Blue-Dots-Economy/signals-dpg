// RJSF v6's form submit does not fire under happy-dom; jsdom implements it.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm } from '../schema-form';
import { formStandardMessage, serverFieldMessage, type FieldErrorCopy } from '../field-error-message';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string, o?: Record<string, unknown>) => {
      let text = d ?? _k;
      for (const [name, value] of Object.entries(o ?? {})) {
        text = text.split(`{{${name}}}`).join(String(value));
      }
      return text;
    },
  }),
}));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const schema = {
  type: 'object',
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Mobile', pattern: '^(\\+91[6-9][0-9]{9}|[6-9][0-9]{9}|\\+[1-9][0-9]{9,14})$' },
  },
} as RJSFSchema;

const REQUIRED = 'Mobile is required.';
const INVALID = 'Invalid entry. Please enter a valid Mobile.';

const copy: FieldErrorCopy = {
  required: (label) => `${label} is required.`,
  invalid: (message) => `Invalid entry. ${message}`,
  validValue: (label) => `Please enter a valid ${label}.`,
};

describe('formStandardMessage', () => {
  const pattern = () => 'Please enter a valid Mobile.';

  it('says a missing field is required, without an example', () => {
    const msg = formStandardMessage(
      { name: 'required', property: 'phone', params: { missingProperty: 'phone' } },
      schema,
      copy,
      pattern,
    );
    expect(msg).toBe(REQUIRED);
  });

  it('treats a blank minLength-1 value as missing', () => {
    const msg = formStandardMessage(
      { name: 'minLength', property: '.name', params: { limit: 1 } },
      schema,
      copy,
      pattern,
    );
    expect(msg).toBe('Name is required.');
  });

  it('says a wrong value is an invalid entry, never the regex', () => {
    const msg = formStandardMessage({ name: 'pattern', property: '.phone' }, schema, copy, pattern);
    expect(msg).toBe(INVALID);
    expect(msg).not.toContain('^');
  });

  it('gives no example for a non-format error, even when the field has one', () => {
    const msg = formStandardMessage(
      { name: 'minLength', property: '.phone', message: 'must NOT have fewer than 12 characters', params: { limit: 12 } },
      schema,
      copy,
      pattern,
    );
    expect(msg).not.toContain('Example');
    expect(msg).toBe('Invalid entry. Please enter a valid Mobile.');
  });

  it('words a length rule in plain language when rule copy is given, never the raw AJV text', () => {
    const msg = formStandardMessage(
      { name: 'minLength', property: '.phone', message: 'must NOT have fewer than 12 characters', params: { limit: 12 } },
      schema,
      { ...copy, rule: (kind, label, limit) => `${kind}:${label}:${limit}` },
      pattern,
    );
    expect(msg).toBe('Invalid entry. minLength:Mobile:12.');
    expect(msg).not.toContain('must NOT');
  });

  it('names the list, not the index, for an error on an array item', () => {
    const msg = formStandardMessage(
      { name: 'minLength', property: '.cities.0', params: { limit: 1 } },
      { type: 'object', properties: { cities: { type: 'array', title: 'Cities', items: { type: 'string', minLength: 1 } } } },
      copy,
      pattern,
    );
    expect(msg).toBe('Cities is required.');
  });

  it('falls back to the field key when the schema has no title', () => {
    const msg = formStandardMessage(
      { name: 'format', property: '.website' },
      { type: 'object', properties: { website: { type: 'string' } } },
      copy,
      pattern,
    );
    expect(msg).toBe('Invalid entry. Please enter a valid website.');
  });
});

describe('SchemaForm form standard', () => {
  it('shows a wrong value once the field is left, but not "required" on an untouched field', async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} submitButtonText="Save" />);
    await user.type(screen.getByLabelText(/Mobile/), '123');
    await user.tab();
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    expect(screen.queryByText('Name is required.')).toBeNull();
  });

  it('does not show "required" when an empty field is left', async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} submitButtonText="Save" />);
    await user.click(screen.getByLabelText(/Mobile/));
    await user.tab();
    expect(screen.queryByText(REQUIRED)).toBeNull();
  });

  it('on Submit, says each empty field is required under its box', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SchemaForm schema={schema} onSubmit={onSubmit} submitButtonText="Save" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(REQUIRED)).toBeInTheDocument();
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    const mobile = screen.getByLabelText(/Mobile/);
    expect(mobile).toHaveAttribute('aria-invalid', 'true');
    expect(mobile.getAttribute('placeholder') ?? '').not.toContain('required');
    expect(screen.queryByText(/is required\. Example/)).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows "Invalid entry" under the box when the field holds a wrong value', async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={schema} formData={{ name: 'Asha' }} onSubmit={vi.fn()} submitButtonText="Save" />);
    await user.type(screen.getByLabelText(/Mobile/), '123');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
  });

  it('clears a field message while the user fixes it after a Submit', async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={schema} formData={{ name: 'Asha' }} onSubmit={vi.fn()} submitButtonText="Save" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const mobile = screen.getByLabelText(/Mobile/);
    await waitFor(() => expect(mobile).toHaveAttribute('aria-invalid', 'true'));
    await user.type(mobile, '9876543210');
    await waitFor(() => expect(mobile).not.toHaveAttribute('aria-invalid'));
    expect(screen.queryByText(REQUIRED)).toBeNull();
  });
});

describe('serverFieldMessage bounds', () => {
  const ruleCopy: FieldErrorCopy = {
    ...copy,
    rule: (kind, label, limit) => `${kind}:${label}:${limit}`,
  };

  it('keeps inclusive and exclusive bounds apart', () => {
    expect(serverFieldMessage('name', 'must be >= 14', schema, ruleCopy)).toBe('Invalid entry. minimum:Name:14.');
    expect(serverFieldMessage('name', 'must be > 0', schema, ruleCopy)).toBe('Invalid entry. exclusiveMinimum:Name:0.');
    expect(serverFieldMessage('name', 'must be < 100', schema, ruleCopy)).toBe('Invalid entry. exclusiveMaximum:Name:100.');
  });
});

describe('serverFieldMessage', () => {
  it('words the API messages in the form standard', () => {
    expect(serverFieldMessage('phone', 'is required', schema, copy)).toBe(REQUIRED);
    expect(serverFieldMessage('phone', 'Please enter a valid Mobile.', schema, copy)).toBe(INVALID);
    expect(serverFieldMessage('phone', 'must NOT have fewer than 10 characters', schema, copy)).toBe(
      'Invalid entry. Please enter a valid Mobile.',
    );
    expect(serverFieldMessage('name', 'must be one of: a, b', schema, copy)).toBe(
      'Invalid entry. Please enter a valid Name.',
    );
    expect(serverFieldMessage('extra', 'is not an allowed field', schema, copy)).toBeNull();
  });
});

describe('SchemaForm server field errors', () => {
  it('shows a server field error under its field until that field is edited', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SchemaForm schema={schema} formData={FILLED} onSubmit={vi.fn()} submitButtonText="Save" />,
    );
    rerender(
      <SchemaForm
        schema={schema}
        formData={FILLED}
        onSubmit={vi.fn()}
        submitButtonText="Save"
        serverErrors={SERVER_ERRORS}
      />,
    );
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    const mobile = screen.getByLabelText(/Mobile/);
    expect(mobile).toHaveAttribute('aria-invalid', 'true');
    await user.type(mobile, '1');
    await waitFor(() => expect(screen.queryByText(INVALID)).toBeNull());
  });
});

const FILLED = { name: 'Asha', phone: '9876543210' };
const SERVER_ERRORS = { phone: 'Please enter a valid Mobile.' };
