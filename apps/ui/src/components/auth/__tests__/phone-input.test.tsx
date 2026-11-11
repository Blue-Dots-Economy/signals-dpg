import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  PhoneInput,
  isAcceptedPhone,
  isPhoneFieldName,
  joinPhone,
  nationalFromInput,
  phoneValueMode,
  splitPhone,
} from '../phone-input';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

function Harness({ onValue, nationalOnly = false }: Readonly<{ onValue: (v: string) => void; nationalOnly?: boolean }>) {
  const [value, setValue] = React.useState('');
  return (
    <label>
      Mobile
      <PhoneInput
        id="m"
        nationalOnly={nationalOnly}
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    </label>
  );
}

describe('PhoneInput', () => {
  it('starts at +91 and keeps only 10 digits for India', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    expect(screen.getByLabelText('Country code')).toHaveValue('+91');
    const number = document.getElementById('m') as HTMLInputElement;
    fireEvent.change(number, { target: { value: '4567895678956789' } });
    expect(number.value).toBe('4567895678');
    expect(onValue).toHaveBeenLastCalledWith('+914567895678');
  });

  it('lets the user type another country code', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: '+44' } });
    fireEvent.change(document.getElementById('m') as HTMLInputElement, { target: { value: '7911123456' } });
    expect(onValue).toHaveBeenLastCalledWith('+447911123456');
  });

  it('reads a bare 10-digit value as +91 and joins nothing for an empty number', () => {
    expect(splitPhone('9876543210')).toEqual({ code: '+91', national: '9876543210' });
    expect(splitPhone('+919876543210')).toEqual({ code: '+91', national: '9876543210' });
    expect(joinPhone('+91', '')).toBe('');
  });

  it('reads a pasted full number instead of cutting it into a different one', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const number = document.getElementById('m') as HTMLInputElement;
    fireEvent.paste(number, { clipboardData: { getData: () => '+91 98765 43210' } });
    expect(onValue).toHaveBeenLastCalledWith('+919876543210');
    expect(nationalFromInput('919876543210', '+91').national).toBe('9876543210');
    expect(nationalFromInput('098765 43210', '+91').national).toBe('9876543210');
  });

  it('never saves a number under an emptied code box', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(document.getElementById('m') as HTMLInputElement, { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith('+919876543210');
    fireEvent.blur(screen.getByLabelText('Country code'));
    expect(screen.getByLabelText('Country code')).toHaveValue('+91');
  });

  it('stores only the 10 digits when the field takes no country code', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} nationalOnly />);
    expect(screen.getByLabelText('Country code')).toHaveAttribute('readonly');
    fireEvent.change(document.getElementById('m') as HTMLInputElement, { target: { value: '9876543210' } });
    expect(onValue).toHaveBeenLastCalledWith('9876543210');
  });

  it('matches only real phone field names, and reads the mode from the pattern', () => {
    expect(isPhoneFieldName('mobile_number')).toBe(true);
    expect(isPhoneFieldName('Phone Number')).toBe(true);
    expect(isPhoneFieldName('mobile_app_url')).toBe(false);
    expect(isPhoneFieldName('automobile')).toBe(false);
    expect(phoneValueMode('^[0-9]{10}$')).toBe('national');
    expect(phoneValueMode('^(\\+91[6-9][0-9]{9}|[6-9][0-9]{9}|\\+[1-8][0-9]{9,14}|\\+9[02-9][0-9]{8,13})$')).toBe('international');
  });

  it('blue_dot phone rule rejects a short +91 number instead of reading it as another country', () => {
    const network = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../../../examples/schemas/blue_dot/network.json'), 'utf8'),
    );
    const patterns = new Set<string>();
    JSON.stringify(network, (key, value) => {
      if (key === 'pattern' && typeof value === 'string' && value.includes('+91')) patterns.add(value);
      return value;
    });
    expect(patterns.size).toBe(1);
    const re = new RegExp([...patterns][0]!);
    for (const ok of ['+919353500020', '9353500020', '+447911123456', '+12025550123', '+971501234567']) {
      expect(re.test(ok)).toBe(true);
    }
    for (const bad of ['+91935350002', '+915353500020', '935350002', '+9193535000201']) {
      expect(re.test(bad)).toBe(false);
    }
  });

  it('keeps +91 for a partial value and accepts landlines as contact numbers', () => {
    expect(splitPhone('+91987')).toEqual({ code: '+91', national: '987' });
    expect(isAcceptedPhone('+918023456789')).toBe(true);
    expect(isAcceptedPhone('12345')).toBe(false);
  });
});
