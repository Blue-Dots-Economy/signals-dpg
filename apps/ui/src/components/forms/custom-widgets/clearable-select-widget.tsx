/**
 * `SelectWidget` for enum fields: a keyboard-navigable dropdown that an
 * optional field can be cleared.
 *
 * Replaces `@rjsf/shadcn`'s single-value `FancySelect`, which is not keyboard
 * usable: arrow keys move no visible highlight (cmdk ignores a plain-button
 * trigger) and the trigger stops Enter from reaching cmdk. Built on the app's
 * Radix `ui/select` instead.
 *
 * `multiple` fields still use the theme's `FancyMultiSelect`, which has a real
 * `CommandInput` and works with the keyboard.
 */
import { X } from 'lucide-react';
import { Widgets } from '@rjsf/shadcn';
import {
  enumOptionsIndexForValue,
  enumOptionsValueForIndex,
  type EnumOptionsType,
  type WidgetProps,
} from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const ThemeSelectWidget = Widgets.SelectWidget;

export function ClearableSelectWidget(props: Readonly<WidgetProps>) {
  const { t } = useTranslation();
  const {
    id,
    value,
    required,
    disabled,
    readonly,
    multiple,
    autofocus,
    onChange,
    onBlur,
    onFocus,
    options,
    placeholder,
    rawErrors = [],
  } = props;

  if (multiple) return <ThemeSelectWidget {...props} />;

  const enumOptions = (options.enumOptions ?? []) as EnumOptionsType[];
  const enumDisabled = options.enumDisabled as EnumOptionsType['value'][] | undefined;

  // Radix items are strings and enum values may not be, so the option index is
  // the item value (as RJSF's helpers do). `''` means no selection.
  const selectedIndex = (enumOptionsIndexForValue(value, enumOptions, false) as string) ?? '';

  // Only for an optional, editable field that holds a value.
  const clearable = !required && selectedIndex !== '' && !disabled && !readonly;

  return (
    <div className="relative">
      <Select
        value={selectedIndex}
        onValueChange={(index) =>
          onChange(enumOptionsValueForIndex(index, enumOptions, options.emptyValue))
        }
        disabled={disabled || readonly}
        required={required}
      >
        <SelectTrigger
          id={id}
          autoFocus={autofocus}
          onBlur={() => onBlur(id, value)}
          onFocus={() => onFocus(id, value)}
          aria-invalid={rawErrors.length > 0 || undefined}
          // Pad the value, not the trigger, so the chevron stays put and the
          // clear button fits between them.
          className={cn(clearable && '*:data-[slot=select-value]:pr-7')}
        >
          <SelectValue placeholder={placeholder || t('form.select_placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {enumOptions.map(({ value: optionValue, label }, index) => (
            <SelectItem
              key={`${index}-${label}`}
              value={String(index)}
              disabled={Array.isArray(enumDisabled) && enumDisabled.includes(optionValue)}
            >
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {clearable && (
        <button
          type="button"
          // Usually `undefined`, so RJSF drops the key from `formData` rather
          // than storing an empty string.
          onClick={() => onChange(options.emptyValue)}
          aria-label={t('form.clear_selection')}
          title={t('form.clear_selection')}
          // Overlaid, not nested: the trigger is itself a <button>. `right-8`
          // clears the chevron (12px padding + 16px icon).
          className={cn(
            'absolute inset-y-0 right-8 my-auto flex size-6 items-center justify-center',
            'rounded-md text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
