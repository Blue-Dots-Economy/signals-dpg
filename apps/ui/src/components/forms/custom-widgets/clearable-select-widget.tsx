/**
 * `SelectWidget` for single-value enum fields: the theme's own select, plus a
 * way back to empty.
 *
 * Once a value had been picked there was no way to unpick it. Every entry in
 * `@rjsf/shadcn`'s `FancySelect` dropdown sets a value, and re-clicking the
 * current one just re-sets it — so an optional field stayed answered on the
 * strength of a single mis-click, with no path back to "not answered". RJSF's
 * own HTML `<select>` widget adds an empty option for exactly this reason when
 * a field isn't required; `FancySelect` renders only the enum options.
 *
 * Rather than reimplement the select (and lose its dropdown, keyboard handling
 * and check-mark styling, or fork it into this repo), this composes the theme
 * widget and overlays a clear button on its trigger. The button is a SIBLING
 * of the trigger, not a child: `FancySelect` renders its trigger as a
 * `<button>`, and a button nested inside a button is invalid HTML that
 * browsers resolve by dropping the inner one.
 *
 * `multiple` (array-of-enum) fields fall straight through — those render
 * `FancyMultiSelect`, whose chips are individually removable already.
 */
import { X } from 'lucide-react';
import { Widgets } from '@rjsf/shadcn';
import type { WidgetProps } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const ThemeSelectWidget = Widgets.SelectWidget;

/** True when the field holds something a reader would call a value. */
function hasValue(value: unknown): boolean {
  // Not a truthiness check: an enum of numbers or booleans can legitimately
  // hold `0` or `false`, and those are answers like any other.
  return value !== undefined && value !== null && value !== '';
}

export function ClearableSelectWidget(props: WidgetProps) {
  const { t } = useTranslation();
  const { multiple, required, disabled, readonly, value, onChange, options } = props;

  // Only offered where clearing is both allowed and meaningful: a single-value
  // optional field that currently holds something and isn't locked. A required
  // field is deliberately excluded — emptying it is not a state it may hold,
  // so the button would invite a validation error rather than a choice.
  const clearable =
    !multiple && !required && !disabled && !readonly && hasValue(value);

  if (!clearable) return <ThemeSelectWidget {...props} />;

  return (
    <div
      // `pr-11` on the trigger keeps a long selected label from sliding under
      // the button. Applied by descendant selector rather than through
      // `props.className`, which the theme widget also puts on its wrapping
      // `Command` element — the same `aria-haspopup=listbox` targeting the
      // form's own left-align fix uses.
      className="relative [&_button[aria-haspopup=listbox]]:pr-11"
    >
      <ThemeSelectWidget {...props} />
      <button
        type="button"
        // `emptyValue` rather than a bare `undefined`, matching what the theme
        // widget's own `enumOptionValueDecoder` falls back to. With no
        // `ui:emptyValue` set (the norm) it IS `undefined`, and RJSF then drops
        // the key from `formData` instead of storing an empty string.
        onClick={() => onChange(options.emptyValue)}
        aria-label={t('form.clear_selection')}
        title={t('form.clear_selection')}
        className={cn(
          // `top-0.5` + `h-9` mirror the theme widget's own `p-0.5` wrapper and
          // its `h-9` trigger, so the icon lands centred on the trigger and not
          // on the taller box that includes the option description below it.
          'absolute right-8 top-0.5 flex h-9 w-6 items-center justify-center',
          'rounded-md text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
