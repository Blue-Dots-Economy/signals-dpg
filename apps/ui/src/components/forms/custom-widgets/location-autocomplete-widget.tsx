import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getGeoProvider } from '@/lib/geo/provider';
import type { GeoSuggestion } from '@/lib/geo/types';

interface LocationFormContext {
  onLocationResolved?: (coords: { lat: number; lng: number } | null) => void;
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

  React.useEffect(() => {
    const q = text.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      const results = await provider.suggest(q, controller.signal);
      if (!controller.signal.aborted) {
        setSuggestions(results);
        setOpen(results.length > 0);
      }
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [text, provider]);

  function choose(s: GeoSuggestion) {
    setText(s.label);
    onChange(s.label);
    ctx.onLocationResolved?.({ lat: s.lat, lng: s.lng });
    setOpen(false);
    setSuggestions([]);
  }

  return (
    <div className="relative space-y-2">
      <Input
        id={id}
        value={text}
        disabled={disabled || readonly}
        autoComplete="off"
        className={cn(rawErrors && rawErrors.length > 0 && 'border-destructive')}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
          ctx.onLocationResolved?.(null);
        }}
        onFocus={() => setOpen(suggestions.length > 0)}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          {suggestions.map((s, i) => (
            <li key={`${s.lat},${s.lng},${i}`}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => choose(s)}
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
