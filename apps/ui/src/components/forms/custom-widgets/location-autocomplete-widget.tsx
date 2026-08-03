import * as React from 'react';
import { createPortal } from 'react-dom';
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
  options,
}: WidgetProps) {
  const ctx = (formContext ?? {}) as LocationFormContext;
  const isPrimary = (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;
  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  const provider = React.useMemo(() => getGeoProvider(), []);
  const inputRef = React.useRef<HTMLInputElement>(null);
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
    // Emit `undefined` (not "") when cleared, so a required location field goes
    // back to invalid — an empty string counts as "present" for JSON-Schema
    // `required`, which let an emptied location slip past validation (a normal
    // text widget clears to undefined, which is why other required fields did
    // invalidate on clear but this one didn't).
    onChange(next === '' ? undefined : next);
    // The freshly typed text is no longer a resolved place — drop prior coords
    // so the submit-time fallback re-geocodes (or the next selection sets them).
    // Only the primary field feeds item_locations.
    if (isPrimary) ctx.onLocationResolved?.(null);
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
    if (isPrimary) {
      ctx.onLocationResolved?.({ lat: s.lat, lng: s.lng, components: s.components });
    }
  }

  // The suggestions list is rendered in a portal (fixed-positioned under the
  // input) rather than as an absolute child. Inside a scrolling container
  // (`<main overflow-y-auto>`) an absolute dropdown is CLIPPED at the container
  // edge and hidden behind the pinned footer; a body portal escapes both.
  const menuOpen = open && suggestions.length > 0;
  const [menuRect, setMenuRect] = React.useState<DOMRect | null>(null);
  React.useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuRect(null);
      return;
    }
    const update = () => {
      const el = inputRef.current;
      if (el) setMenuRect(el.getBoundingClientRect());
    };
    update();
    // capture=true so this also fires for the scrolling <main> ancestor (scroll
    // events don't bubble) — keeps the fixed dropdown glued to the input instead
    // of detaching when the form is scrolled.
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [menuOpen]);

  return (
    <div className="relative space-y-2">
      <Input
        ref={inputRef}
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
      {menuOpen && menuRect &&
        createPortal(
          <ul
            style={{
              position: 'fixed',
              top: menuRect.bottom + 4,
              left: menuRect.left,
              width: menuRect.width,
              zIndex: 60,
            }}
            className="max-h-60 overflow-auto rounded-md border bg-popover shadow-md"
          >
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
          </ul>,
          document.body,
        )}
      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
