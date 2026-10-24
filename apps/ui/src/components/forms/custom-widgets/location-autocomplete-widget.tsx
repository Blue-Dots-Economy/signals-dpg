import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getGeoProvider } from '@/lib/geo/provider';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import type { GeoComponents, GeoSuggestion } from '@/lib/geo/types';

/** A selected place reported to the form: the exact point plus its address components. */
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
  registry,
  options,
}: WidgetProps) {
  // RJSF v6 exposes `formContext` only on the registry, not as a widget prop.
  const ctx = (registry?.formContext ?? {}) as LocationFormContext;
  const isPrimary = (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;
  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  // Open the list upward near the viewport bottom (e.g. above the pinned
  // action bar).
  const [dropUp, setDropUp] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const provider = React.useMemo(() => getGeoProvider(), []);
  const debounceRef = React.useRef<number | undefined>(undefined);
  const blurRef = React.useRef<number | undefined>(undefined);
  const abortRef = React.useRef<AbortController | null>(null);

  // Sync the input when RJSF pushes a new value. No search here: only typing
  // searches, so selecting a suggestion never re-opens the list.
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

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
        if (results.length > 0) {
          // ~260px covers the list plus the footer.
          const r = inputRef.current?.getBoundingClientRect();
          setDropUp(!!r && window.innerHeight - r.bottom < 260);
        }
      });
    }, 300);
  }

  function handleInput(next: string) {
    setText(next);
    // `undefined`, not "", when cleared: an empty string satisfies JSON Schema
    // `required`.
    onChange(next === '' ? undefined : next);
    // Typed text is unresolved, so drop prior coords; submit geocodes the
    // text instead. Only the primary field feeds item_locations.
    if (isPrimary) ctx.onLocationResolved?.(null);
    runSearch(next);
  }

  async function choose(s: GeoSuggestion) {
    // Cancel any pending search so selecting never re-opens the list.
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setText(s.label);
    onChange(s.label);
    setSuggestions([]);
    setOpen(false);

    // The page submits the exact point; for a private field the server
    // jitters it before storing.
    if (isPrimary) {
      ctx.onLocationResolved?.({ lat: s.lat, lng: s.lng, components: s.components });
    }
  }

  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (index) => {
        const s = suggestions[index];
        if (s) void choose(s);
      },
      idPrefix: id,
    });

  return (
    <div className="relative space-y-2">
      <Input
        ref={inputRef}
        id={id}
        value={text}
        disabled={disabled || readonly}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        className={cn(rawErrors && rawErrors.length > 0 && 'border-destructive')}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(suggestions.length > 0)}
        onBlur={() => {
          // Delay the close so a suggestion mousedown still registers.
          blurRef.current = window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute left-0 z-50 max-h-60 w-full overflow-auto rounded-md border bg-popover shadow-md',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {suggestions.map((s, i) => (
            // `role="option"` on the item, not a nested <button>: a listbox may
            // only contain options, and `aria-activedescendant` targets them.
            <li
              key={`${s.lat},${s.lng},${i}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              className={cn(
                'cursor-pointer px-3 py-2 text-sm',
                i === activeIndex ? 'bg-accent' : 'hover:bg-accent',
              )}
              // onMouseDown so selection runs before the input's blur;
              // preventDefault keeps focus in the input.
              onMouseDown={(e) => {
                e.preventDefault();
                void choose(s);
              }}
              // Hover moves the keyboard highlight, so Enter takes what is shown.
              onMouseEnter={() => setActiveIndex(i)}
            >
              {s.label}
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
