import * as React from 'react';
import { errorId, type WidgetProps } from '@rjsf/utils';
import { PhoneInput, joinPhone, phoneValueMode, splitPhone } from '@/components/auth/phone-input';

/** The stored value in this widget's own layout, or `undefined` when it already is. */
function tidyPhone(value: unknown, nationalOnly: boolean): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const { code, national } = splitPhone(value);
  const next = nationalOnly ? national : joinPhone(code, national);
  return next && next !== value ? next : undefined;
}

/** Schema-form phone field: the fixed country code plus the number. */
export function PhoneWidget({ id, value, onChange, onBlur, disabled, readonly, rawErrors, placeholder, schema }: Readonly<WidgetProps>) {
  const invalid = Boolean(rawErrors && rawErrors.length > 0);
  const current = typeof value === 'string' ? value : '';
  const nationalOnly = phoneValueMode(schema.pattern) === 'national';
  // A value saved in another layout (`+91 98765 43210`, `919876543210`) is
  // stored in the form this widget writes, so it is checked as shown.
  const tidy = tidyPhone(value, nationalOnly);
  React.useEffect(() => {
    if (tidy !== undefined) onChange(tidy);
  }, [tidy, onChange]);
  return (
    <PhoneInput
      id={id}
      nationalOnly={nationalOnly}
      value={current}
      onChange={(next) => onChange(next || undefined)}
      onBlur={() => onBlur(id, current)}
      disabled={Boolean(disabled || readonly)}
      invalid={invalid}
      {...(invalid ? { describedBy: errorId(id) } : {})}
      {...(placeholder ? { placeholder } : {})}
    />
  );
}
