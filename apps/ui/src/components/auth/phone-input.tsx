import { cn } from '@/lib/utils';

/** Fixed India dial code shown beside every phone field. */
export const IN_DIAL_CODE = '+91';

/** Keep a phone field to at most 10 national digits (strip everything else). */
export function sanitizeNationalPhone(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 10);
}

/** Assemble the E.164 wire value from a 10-digit national number. */
export function toE164(national: string): string {
  return national ? `${IN_DIAL_CODE}${national}` : '';
}

export interface PhoneInputProps {
  id: string;
  /** The national 10-digit number (no country code). */
  value: string;
  /** Receives the sanitized national number. */
  onChange: (national: string) => void;
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
}

/**
 * Phone field with a fixed "🇮🇳 +91" prefix and a 10-digit national input.
 * The country code is never typed, so it can't be mistyped or duplicated;
 * the parent assembles the E.164 value via `toE164(value)`. Used by both the
 * login form and the guardian form.
 */
export function PhoneInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  invalid,
  className,
}: PhoneInputProps) {
  return (
    <div
      className={cn(
        'flex h-11 items-stretch overflow-hidden rounded-md border border-input bg-transparent shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        invalid && 'border-amber-500 focus-within:border-amber-500 focus-within:ring-amber-500/40',
        className,
      )}
    >
      <span className="flex select-none items-center border-r border-input bg-muted px-3 text-sm text-muted-foreground">
        🇮🇳 {IN_DIAL_CODE}
      </span>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        maxLength={10}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(sanitizeNationalPhone(e.target.value))}
        disabled={disabled}
        aria-invalid={invalid}
        className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none disabled:opacity-60"
      />
    </div>
  );
}
