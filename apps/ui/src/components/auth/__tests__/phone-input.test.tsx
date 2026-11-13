import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  PhoneInput,
  isAcceptedPhone,
  acceptsListedPhone,
  isPhoneFieldName,
  joinPhone,
  nationalFromInput,
  parsePhoneCountries,
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
    expect(screen.getByLabelText('Country code')).toHaveTextContent('+91');
    const number = document.getElementById('m') as HTMLInputElement;
    fireEvent.change(number, { target: { value: '4567895678956789' } });
    expect(number.value).toBe('4567895678');
    expect(onValue).toHaveBeenLastCalledWith('+914567895678');
  });

  it('offers no way to type or change the country code', () => {
    render(<Harness onValue={vi.fn()} />);
    expect(screen.getByLabelText('Country code').tagName).toBe('SPAN');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('keeps every digit of a pasted number with an unlisted code, so it fails validation', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.paste(document.getElementById('m') as HTMLInputElement, {
      clipboardData: { getData: () => '+61 412 345 678' },
    });
    expect(onValue).toHaveBeenLastCalledWith('+9161412345678');
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

  it('stores only the 10 digits when the field takes no country code', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} nationalOnly />);
    expect(screen.getByLabelText('Country code')).toHaveTextContent('+91');
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

  it('blue_dot phone rules: a seeker phone is a mobile, a hiring-manager phone may be a landline', () => {
    const network = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../../../examples/schemas/blue_dot/network.json'), 'utf8'),
    );
    const patternOf = (field: string): RegExp => {
      let found: string | undefined;
      JSON.stringify(network, (key, value) => {
        if (key === field && typeof value?.pattern === 'string') found = value.pattern;
        return value;
      });
      expect(found).toBeDefined();
      return new RegExp(found!);
    };
    const mobile = patternOf('phone');
    for (const ok of ['+919353500020', '9353500020', '+447911123456', '+12025550123', '+971501234567']) {
      expect(mobile.test(ok)).toBe(true);
    }
    for (const bad of ['+91935350002', '+915353500020', '935350002', '+9193535000201', '+911123456789']) {
      expect(mobile.test(bad)).toBe(false);
    }
    const contact = patternOf('hiringManagerPhoneNumber');
    for (const ok of ['+911123456789', '01123456789', '+919353500020']) expect(contact.test(ok)).toBe(true);
    for (const bad of ['+91935350002', '12345', '0000000000', '0123456789', '+910000000000']) {
      expect(contact.test(bad)).toBe(false);
    }
  });

  it('gives the phone box only to fields whose pattern accepts a listed country', () => {
    expect(acceptsListedPhone('^[0-9]{10}$')).toBe(true);
    expect(acceptsListedPhone(undefined)).toBe(false);
    expect(acceptsListedPhone('^[A-Z]{3}$')).toBe(false);
    expect(acceptsListedPhone('^\\+44[0-9]{10}$')).toBe(false);
    expect(splitPhone('09876543210')).toEqual({ code: '+91', national: '9876543210' });
  });

  it('keeps +91 for a partial value and accepts landlines as contact numbers', () => {
    expect(splitPhone('+91987')).toEqual({ code: '+91', national: '987' });
    expect(isAcceptedPhone('+918023456789')).toBe(true);
    expect(isAcceptedPhone('12345')).toBe(false);
    expect(isAcceptedPhone('+91935350600')).toBe(false);
    expect(isAcceptedPhone('+9193535060012')).toBe(false);
    expect(isAcceptedPhone('+447911123456')).toBe(true);
    for (const bad of ['0000000000', '0123456789', '+910000000000']) expect(isAcceptedPhone(bad)).toBe(false);
  });
});

describe('phone country list from runtime config', () => {
  it('reads ISO:dial code pairs in order and skips bad or repeated entries', () => {
    const list = parsePhoneCountries(' in:+91, GB:44 ,XX, US:+1, CA:+1, FR:+0');
    expect(list.map((c) => `${c.iso}${c.code}`)).toEqual(['IN+91', 'GB+44', 'US+1']);
    expect(list[0]).toMatchObject({ flag: '🇮🇳', nationalDigits: 10 });
    expect(parsePhoneCountries('AE:+971')[0]).toMatchObject({ code: '+971', flag: '🇦🇪' });
  });

  it('defaults to India when unset or unreadable', () => {
    for (const raw of [undefined, '', 'nonsense']) {
      expect(parsePhoneCountries(raw).map((c) => c.code)).toEqual(['+91']);
    }
  });

  async function loadWith(countries: string | undefined) {
    vi.resetModules();
    (window as { __DPG_UI_CONFIG__?: Record<string, string> }).__DPG_UI_CONFIG__ =
      countries === undefined ? undefined : { VITE_PHONE_COUNTRIES: countries };
    return import('../phone-input');
  }

  it('shows a code list only when more than one country is configured, starting at the first', async () => {
    try {
      const multi = await loadWith('GB:+44,IN:+91');
      render(<multi.PhoneInput id="p" value="" onChange={vi.fn()} />);
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('+44');
      expect([...select.options].map((o) => o.value)).toEqual(['+44', '+91']);
      expect(multi.acceptsListedPhone('^\\+44[0-9]{10}$')).toBe(true);
    } finally {
      await loadWith(undefined);
    }
  });

  it('keeps fixed code text for a single configured country', async () => {
    try {
      const single = await loadWith('AE:+971');
      render(<single.PhoneInput id="p" value="" onChange={vi.fn()} />);
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.getByLabelText('Country code')).toHaveTextContent('+971');
      expect(single.nationalMaxLength('+971')).toBe(12);
    } finally {
      await loadWith(undefined);
    }
  });
});
