import * as React from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** When false the option is listed but not choosable, with `reason` explaining why. */
  available?: boolean;
  /** Required when `available` is false — already localized. */
  reason?: string;
  /**
   * Sub-label for a choosable option (e.g. "By when it was posted"). An
   * option shows either `hint` or `reason`, never both.
   */
  hint?: string;
}

export interface OptionSelectProps<T extends string> {
  /** Short prefix shown before the current value, e.g. "Sort". */
  name: string;
  /** The value to display. May differ from the requested one; see SortSelect. */
  displayLabel: string;
  /**
   * Icon shown instead of the text below `sm`, where prefix plus value is too
   * wide for the toolbar row. The popover still ticks the current choice.
   */
  icon: React.ComponentType<{ className?: string }>;
  options: SelectOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /**
   * Lift the portalled list above the maximized map (`fixed inset-0
   * z-[2000]`, `map-container.tsx`). `PopoverContent` portals to
   * `document.body`, so its base `z-50` would paint under that layer while
   * holding focus (WCAG 2.4.11). Uses the same 2100 as the other overlay
   * occupants.
   */
  aboveMaximizedMap?: boolean;
  /**
   * Optional caption above the list, for when `name` does not say what
   * picking an option does. When present it labels the listbox instead of
   * `name`. The visible caption is `aria-hidden` because the same string is
   * already the listbox `aria-label`.
   */
  heading?: string;
}

/**
 * Single-choice dropdown shared by `SortSelect` and `LocationSourceSelect`.
 * Unlike a native `<select>` it can list an unavailable option with a reason,
 * label the trigger differently from the selected value, and use the app's
 * coarse-pointer touch targets.
 */
export function OptionSelect<T extends string>({
  name,
  displayLabel,
  icon: Icon,
  options,
  value,
  onChange,
  heading,
  aboveMaximizedMap = false,
}: Readonly<OptionSelectProps<T>>) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Carries the value too, because below `sm` the text is hidden.
          aria-label={`${name}: ${displayLabel}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-border bg-background text-xs font-semibold text-foreground',
            // Square while icon-only, so it matches the Filters trigger beside it.
            'h-9 w-9 justify-center px-0 sm:h-auto sm:w-auto sm:justify-start sm:px-2.5 sm:py-1.5',
            'pointer-coarse:min-h-11 pointer-coarse:min-w-11 sm:pointer-coarse:min-w-0',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            'hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <Icon className="h-4 w-4 shrink-0 sm:hidden" />
          <span className="hidden font-normal text-muted-foreground sm:inline">{name}</span>
          <span className="hidden truncate sm:inline">{displayLabel}</span>
          <ChevronDown className="hidden h-3 w-3 shrink-0 opacity-60 sm:block" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-1"
        style={aboveMaximizedMap ? { zIndex: 2100 } : undefined}
      >
        {heading && (
          <p
            aria-hidden="true"
            className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {heading}
          </p>
        )}
        <div role="listbox" aria-label={heading ?? name}>
          {options.map((o) => {
            const unavailable = o.available === false;
            const reasonId = unavailable && o.reason ? `opt-why-${name}-${o.value}` : undefined;
            return (
              <React.Fragment key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  // aria-disabled rather than `disabled`, so the option and its
                  // reason stay reachable by assistive tech.
                  aria-disabled={unavailable}
                  aria-describedby={reasonId}
                  onClick={() => {
                    if (unavailable) return;
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs',
                    'pointer-coarse:min-h-11',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    unavailable
                      ? 'cursor-not-allowed text-muted-foreground/50'
                      : 'hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-3 w-3 shrink-0',
                      o.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className="flex-1">
                    <span className="block font-semibold">{o.label}</span>
                    {unavailable && o.reason && (
                      <span id={reasonId} className="mt-0.5 block font-normal">
                        {o.reason}
                      </span>
                    )}
                    {!unavailable && o.hint && (
                      <span className="mt-0.5 block font-normal text-muted-foreground">
                        {o.hint}
                      </span>
                    )}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
