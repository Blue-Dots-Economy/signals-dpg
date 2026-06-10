import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getGeoProvider } from '@/lib/geo/provider';
import type { GeoComponents, GeoSuggestion } from '@/lib/geo/types';

/** A selected place reported to the form: the exact point plus the address
 * components, so the page can coarsen a private field to its city centroid
 * (using the components) before submit. */
export interface ResolvedPlace {
  lat: number;
  lng: number;
  components?: GeoComponents;
}

interface LocationFormContext {
  onLocationResolved?: (place: ResolvedPlace | null) => void;
}

export function LocationAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  rawErrors,
  formContext,
}: WidgetProps) {
  const ctx = (formContext ?? {}) as LocationFormContext;
  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  const provider = React.useMemo(() => getGeoProvider(), []);
  const debounceRef = React.useRef<number | undefined>(undefined);
  const blurRef = React.useRef<number | undefined>(undefined);
  const abortRef = React.useRef<AbortController | null>(null);

  // Keep the input in sync when RJSF pushes a new value (e.g. edit-mode
  // prefill). This intentionally does NOT trigger a search — searching is
  // driven only by user typing (see runSearch in handleInput), so selecting a
  // suggestion (which calls onChange and updates `value`) never re-opens the
  // dropdown.
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

  // Cancel any pending work on unmount.
  React.useEffect(
    () => () => {
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(blurRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  function runSearch(query: string) {
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      void provider.suggest(q, controller.signal).then((results) => {
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setOpen(results.length > 0);
      });
    }, 300);
  }

  function handleInput(next: string) {
    setText(next);
    onChange(next);
    // The freshly typed text is no longer a resolved place — drop prior coords
    // so the submit-time fallback re-geocodes (or the next selection sets them).
    ctx.onLocationResolved?.(null);
    runSearch(next);
  }

  async function choose(s: GeoSuggestion) {
    // Cancel any pending/in-flight search so selecting never re-opens the list.
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setText(s.label);
    onChange(s.label);
    setSuggestions([]);
    // Close the dropdown immediately — before any async work — so the UI stays
    // responsive regardless of how long the coarse geocode takes.
    setOpen(false);

    // Report the selected place — exact point plus its address components. The
    // page decides how to use it: for a public field the exact point is stored;
    // for a PRIVATE field the page coarsens to the city centroid (via the
    // components) at submit time, so the exact point never leaves the browser.
    ctx.onLocationResolved?.({ lat: s.lat, lng: s.lng, components: s.components });
  }

  return (
    <div className="relative space-y-2">
      <Input
        id={id}
        value={text}
        disabled={disabled || readonly}
        autoComplete="off"
        className={cn(rawErrors && rawErrors.length > 0 && 'border-destructive')}
        onChange={(e) => handleInput(e.target.value)}
        onFocus={() => setOpen(suggestions.length > 0)}
        onBlur={() => {
          // Delay the close so a suggestion mousedown still registers.
          blurRef.current = window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          {suggestions.map((s, i) => (
            <li key={`${s.lat},${s.lng},${i}`}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                // onMouseDown (not onClick) so selection runs before the input's
                // blur fires; preventDefault keeps focus from flicking away.
                onMouseDown={(e) => {
                  e.preventDefault();
                  void choose(s);
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
