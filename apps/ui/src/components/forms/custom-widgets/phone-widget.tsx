import { errorId, type WidgetProps } from '@rjsf/utils';
import { PhoneInput, phoneValueMode } from '@/components/auth/phone-input';

/** Schema-form phone field: editable country code (default +91) plus the number. */
export function PhoneWidget({ id, value, onChange, onBlur, disabled, readonly, rawErrors, placeholder, schema }: Readonly<WidgetProps>) {
  const invalid = Boolean(rawErrors && rawErrors.length > 0);
  const current = typeof value === 'string' ? value : '';
  return (
    <PhoneInput
      id={id}
      nationalOnly={phoneValueMode(schema.pattern) === 'national'}
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
