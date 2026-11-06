import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PhoneInput, joinPhone, splitPhone } from '../phone-input';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

function Harness({ onValue }: Readonly<{ onValue: (v: string) => void }>) {
  const [value, setValue] = React.useState('');
  return (
    <label>
      Mobile
      <PhoneInput
        id="m"
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
});
