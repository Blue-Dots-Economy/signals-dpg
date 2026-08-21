// RJSF v6's form submit does not fire under happy-dom (the suite default); jsdom
// implements form submission, so this file overrides the environment per-file.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import validator from '@rjsf/validator-ajv8';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm, getSchemaFormValidity } from '../schema-form';

vi.mock('react-i18next', () => ({
  // Mirrors i18next's `t(key, defaultValue, options)` including {{placeholder}}
  // interpolation — without it, copy under test reads as a literal "{{field}}".
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
  // jsdom implements no layout, so it omits scrollIntoView; focusErrorField calls
  // it on a blocked submit. Every browser engine has it, so this is a harness gap.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/** `phone` is filled-but-invalid; `name` is required-and-empty. Both cases matter. */
const schema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Phone', pattern: '^[0-9]{10}$' },
  },
} as RJSFSchema;

describe('getSchemaFormValidity', () => {
  it('separates a missing required field from a filled-but-invalid one', () => {
    const empty = getSchemaFormValidity(validator, schema, {});
    expect(empty.valid).toBe(false);
    expect(empty.missingRequired).toBe(1);
    expect(empty.invalidValues).toBe(0);

    const badPhone = getSchemaFormValidity(validator, schema, { name: 'Asha', phone: '123' });
    expect(badPhone.valid).toBe(false);
    expect(badPhone.missingRequired).toBe(0);
    expect(badPhone.invalidValues).toBe(1);
  });

  it('counts a required field present but blank as missing, not invalid', () => {
    // A blank string trips minLength rather than `required`, but to the user it is
    // still "you have not filled this in" — the footer copy depends on that.
    const blankSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', title: 'Name', minLength: 1 } },
    } as RJSFSchema;
    const v = getSchemaFormValidity(validator, blankSchema, { name: '' });
    expect(v.valid).toBe(false);
    expect(v.missingRequired).toBe(1);
    expect(v.invalidValues).toBe(0);
  });

  it('reports valid when nothing is wrong', () => {
    const v = getSchemaFormValidity(validator, schema, { name: 'Asha', phone: '9812345670' });
    expect(v).toEqual({ valid: true, missingRequired: 0, invalidValues: 0 });
  });
});

describe('SchemaForm inline errors are gated on blur', () => {
  it('shows no error for an untouched field on mount', () => {
    render(<SchemaForm schema={schema} formData={{}} onSubmit={vi.fn()} submitButtonText="Save" />);
    expect(screen.queryByText(/must have required property|Please enter a valid/i)).toBeNull();
  });

  it('shows an inline error for an invalid value once the field is blurred', async () => {
    const user = userEvent.setup();
    render(
      <SchemaForm schema={schema} formData={{ name: 'Asha' }} onSubmit={vi.fn()} submitButtonText="Save" />,
    );
    const phone = screen.getByLabelText(/Phone/);
    await user.click(phone);
    await user.type(phone, '123');
    // Still typing — nothing should have turned red yet.
    expect(screen.queryByText(/Please enter a valid Phone/i)).toBeNull();
    await user.tab();
    expect(await screen.findByText(/Please enter a valid Phone/i)).toBeInTheDocument();
  });

  it('clears the inline error live once the value becomes valid', async () => {
    const user = userEvent.setup();
    render(
      <SchemaForm schema={schema} formData={{ name: 'Asha' }} onSubmit={vi.fn()} submitButtonText="Save" />,
    );
    const phone = screen.getByLabelText(/Phone/);
    await user.click(phone);
    await user.type(phone, '123');
    await user.tab();
    expect(await screen.findByText(/Please enter a valid Phone/i)).toBeInTheDocument();

    await user.click(phone);
    await user.type(phone, '4567890');
    expect(screen.queryByText(/Please enter a valid Phone/i)).toBeNull();
  });

  it('does not leak an error onto a different, untouched field', async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={schema} formData={{}} onSubmit={vi.fn()} submitButtonText="Save" />);
    const phone = screen.getByLabelText(/Phone/);
    await user.click(phone);
    await user.type(phone, '123');
    await user.tab();
    expect(await screen.findByText(/Please enter a valid Phone/i)).toBeInTheDocument();
    // `name` is required and empty, but the user has never been there.
    expect(screen.queryByText(/must have required property/i)).toBeNull();
  });

  it('does not mark other required fields as errored when one field is typed in', async () => {
    // The reported bug: typing a single letter in Name reddened Age, Gender and
    // Mobile — fields the user had never been near. RJSF puts `rjsf-field-error`
    // on a field it is displaying as invalid, and the theme's own input template
    // reddens the border off that same signal, so this asserts the border too.
    const user = userEvent.setup();
    const wide = {
      type: 'object',
      required: ['name', 'age', 'phone'],
      properties: {
        name: { type: 'string', title: 'Name' },
        age: { type: 'integer', title: 'Age' },
        phone: { type: 'string', title: 'Phone', pattern: '^[0-9]{10}$' },
      },
    } as RJSFSchema;
    const { container } = render(
      <SchemaForm schema={wide} formData={{}} onSubmit={vi.fn()} submitButtonText="Save" />,
    );
    await user.type(screen.getByLabelText(/Name/), 's');
    expect(container.querySelectorAll('.rjsf-field-error')).toHaveLength(0);
  });

  it('reveals every error on a submit attempt, even for untouched fields', async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={schema} formData={{}} onSubmit={vi.fn()} submitButtonText="Save" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/must have required property/i)).toBeInTheDocument();
  });

  it('still blocks submit while a value is invalid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SchemaForm schema={schema} formData={{ name: 'Asha', phone: '123' }} onSubmit={onSubmit} submitButtonText="Save" />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SchemaForm onValidityChange detail', () => {
  it('reports the reason alongside the boolean', async () => {
    const onValidityChange = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ name: 'Asha', phone: '123' }}
        onSubmit={vi.fn()}
        onValidityChange={onValidityChange}
        submitButtonText="Save"
      />,
    );
    // The boolean stays the first argument so existing callers keep working.
    const call = onValidityChange.mock.calls.at(-1);
    expect(call?.[0]).toBe(false);
    expect(call?.[1]).toEqual({ valid: false, missingRequired: 0, invalidValues: 1 });
  });
});
