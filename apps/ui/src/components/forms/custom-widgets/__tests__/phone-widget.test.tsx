import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { WidgetProps } from '@rjsf/utils';
import { PhoneWidget } from '../phone-widget';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

const MOBILE = '^(\\+91[6-9][0-9]{9}|[6-9][0-9]{9}|\\+[1-8][0-9]{9,14}|\\+9[02-9][0-9]{8,13})$';

function renderWidget(value: string | undefined, pattern = MOBILE, extra: Partial<WidgetProps> = {}) {
  const onChange = vi.fn();
  const props = {
    id: 'root_phone',
    value,
    onChange,
    onBlur: vi.fn(),
    onFocus: vi.fn(),
    schema: { type: 'string', pattern },
    rawErrors: [],
    ...extra,
  } as unknown as WidgetProps;
  render(<PhoneWidget {...props} />);
  return onChange;
}

describe('PhoneWidget', () => {
  it('stores a value saved in another layout as +91 and 10 digits', () => {
    expect(renderWidget('+91 98765 43210')).toHaveBeenCalledWith('+919876543210');
    expect(renderWidget('919876543210')).toHaveBeenCalledWith('+919876543210');
  });

  it('leaves a value already in its own layout alone', () => {
    expect(renderWidget('+919876543210')).not.toHaveBeenCalled();
  });

  it('keeps only the 10 digits for a field that stores the bare number', () => {
    expect(renderWidget('+919876543210', '^[0-9]{10}$')).toHaveBeenCalledWith('9876543210');
  });

  it('leaves free text that is not a phone layout untouched', () => {
    expect(renderWidget('call after 5')).not.toHaveBeenCalled();
    expect(renderWidget('98765 ext 12')).not.toHaveBeenCalled();
  });

  it('tidies a layout made of digits, +, spaces, dashes, dots and brackets', () => {
    expect(renderWidget('(+91) 98765-432.10')).toHaveBeenCalledWith('+919876543210');
  });

  it('does not rewrite the value of a disabled or read-only field', () => {
    expect(renderWidget('+91 98765 43210', MOBILE, { disabled: true })).not.toHaveBeenCalled();
    expect(renderWidget('+91 98765 43210', MOBILE, { readonly: true })).not.toHaveBeenCalled();
  });
});
