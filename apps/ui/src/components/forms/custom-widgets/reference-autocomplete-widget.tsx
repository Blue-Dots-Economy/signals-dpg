import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import { getRuntimeEnv } from '@/lib/runtime-env';

/**
 * Autocomplete over an external reference dataset, for fields marked
 * `x-reference-source` in network.json. Fetches `<base>/<dataset>.json` (see
 * `referenceUrl` and `resolveDatasetId`), so large lists live outside
 * network.json.
 *
 * Stores the option name as a plain string, so free-text values still work.
 * The marker is `"source"` or `{ source, subtitle }`, where `subtitle` lists
 * the option fields (`district` | `state`) shown under the name; `[]` means
 * name-only, and the default is `["district"]`.
 *
 * Dataset shapes, both flattened to `{ name, district?, state? }`:
 *   1. `{ states: [{ name, districts: [{ name, organizations: [...] }] }] }`
 *   2. `[{ name, district?, state? }, ...]`
 */

interface ReferenceOption {
  name: string;
  district?: string;
  state?: string;
}

/** Option fields the marker's `subtitle` may reference. */
const SUBTITLE_FIELDS = ['district', 'state'] as const;
type SubtitleField = (typeof SUBTITLE_FIELDS)[number];
const DEFAULT_SUBTITLE: SubtitleField[] = ['district'];

type HierarchicalDataset = {
  states?: Array<{
    name?: string;
    districts?: Array<{
      name?: string;
      organizations?: Array<Record<string, unknown>>;
    }>;
  }>;
};

const MAX_SUGGESTIONS = 50;

// Module-level cache of in-flight promises by source id, so remounts do not
// refetch a large dataset.
const datasetCache = new Map<string, Promise<ReferenceOption[]>>();

function flatten(raw: unknown): ReferenceOption[] {
  if (Array.isArray(raw)) {
    const flat: ReferenceOption[] = [];
    for (const r of raw) {
      const o = r as Record<string, unknown>;
      if (typeof o.name !== 'string') continue;
      flat.push({
        name: o.name,
        district: typeof o.district === 'string' ? o.district : undefined,
        state: typeof o.state === 'string' ? o.state : undefined,
      });
    }
    return flat;
  }

  const ds = raw as HierarchicalDataset;
  const out: ReferenceOption[] = [];
  for (const st of ds.states ?? []) {
    for (const d of st.districts ?? []) {
      for (const org of d.organizations ?? []) {
        const name = typeof org.name === 'string' ? org.name : undefined;
        if (!name) continue;
        out.push({
          name,
          district:
            typeof org.district === 'string' ? org.district : d.name,
          state: typeof org.state === 'string' ? org.state : st.name,
        });
      }
    }
  }
  return out;
}

/**
 * Maps a source to its dataset id. `colleges` is region-scoped per deployment
 * via `VITE_COLLEGE_DATASET` (`ka` | `up`, default `ka`), giving
 * `colleges-<code>`. Other sources are used verbatim.
 */
function resolveDatasetId(source: string): string {
  if (source === 'colleges') {
    const region = getRuntimeEnv('VITE_COLLEGE_DATASET') || 'ka';
    return `colleges-${region}`;
  }
  return source;
}

/**
 * Dataset URL. The base is the UI's own `/reference/` unless the runtime
 * `VITE_REFERENCE_BASE_URL` overrides it; a relative value resolves against
 * the UI origin. A remote host must send CORS headers, since the browser
 * fetches directly.
 */
function referenceUrl(id: string): string {
  const raw = getRuntimeEnv('VITE_REFERENCE_BASE_URL') || '/reference/';
  const base = raw.endsWith('/') ? raw : `${raw}/`;
  return new URL(`${id}.json`, new URL(base, window.location.origin)).toString();
}

function loadDataset(source: string): Promise<ReferenceOption[]> {
  const cached = datasetCache.get(source);
  if (cached) return cached;
  const pending = fetch(referenceUrl(source))
    .then((res) => {
      if (!res.ok) throw new Error(`reference dataset ${source} → ${res.status}`);
      return res.json();
    })
    .then(flatten)
    .catch((err) => {
      // Drop the failed promise from the cache so a later mount can retry.
      datasetCache.delete(source);
      throw err;
    });
  datasetCache.set(source, pending);
  return pending;
}

export function ReferenceAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  rawErrors,
  placeholder,
  options,
}: WidgetProps) {
  const opts = options as
    | { source?: string; subtitleFields?: string[] }
    | undefined;
  const source = opts?.source;
  // Unknown fields are dropped; an explicit list (even `[]`) wins over the
  // default.
  const subtitleFields: SubtitleField[] = Array.isArray(opts?.subtitleFields)
    ? opts.subtitleFields.filter((f): f is SubtitleField =>
        (SUBTITLE_FIELDS as readonly string[]).includes(f),
      )
    : DEFAULT_SUBTITLE;
  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [dataset, setDataset] = React.useState<ReferenceOption[]>([]);
  const [open, setOpen] = React.useState(false);
  const blurRef = React.useRef<number | undefined>(undefined);

  // Sync the input when RJSF pushes a new value.
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

  React.useEffect(() => {
    if (!source) return;
    let live = true;
    void loadDataset(resolveDatasetId(source))
      .then((opts) => {
        if (live) setDataset(opts);
      })
      .catch(() => {
        // On failure the field stays a plain text input.
        if (live) setDataset([]);
      });
    return () => {
      live = false;
    };
  }, [source]);

  React.useEffect(
    () => () => window.clearTimeout(blurRef.current),
    [],
  );

  const suggestions = React.useMemo(() => {
    const q = text.trim().toLowerCase();
    if (q.length < 2) return [];
    return dataset
      .filter((o) => o.name.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [text, dataset]);

  function handleInput(next: string) {
    setText(next);
    onChange(next);
    setOpen(next.trim().length >= 2);
  }

  function choose(o: ReferenceOption) {
    window.clearTimeout(blurRef.current);
    setText(o.name);
    onChange(o.name);
    setOpen(false);
  }

  function subtitle(o: ReferenceOption): string | null {
    const parts = subtitleFields
      .map((f) => o[f])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (index) => {
        const option = suggestions[index];
        if (option) choose(option);
      },
      idPrefix: id,
    });

  return (
    <div className="relative space-y-2">
      <Input
        id={id}
        value={text}
        disabled={disabled || readonly}
        autoComplete="off"
        placeholder={placeholder}
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
          blurRef.current = window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md"
        >
          {suggestions.map((o, i) => {
            const sub = subtitle(o);
            return (
              // `role="option"` on the item; see LocationAutocompleteWidget.
              <li
                key={`${o.name}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm',
                  i === activeIndex ? 'bg-accent' : 'hover:bg-accent',
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="block">{o.name}</span>
                {sub && (
                  <span className="block text-xs text-muted-foreground">{sub}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
