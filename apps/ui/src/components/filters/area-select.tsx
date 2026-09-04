import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea } from '@/lib/browse-discover';
import { cn } from '@/lib/utils';

/**
 * Tappable radii, km. A SMALL set on purpose: `Custom` covers everything
 * else, so the list stays short enough to read at a glance.
 *
 * Overridable via `presetsKm` — the values themselves were never part of
 * #644, which specifies only `{ mode: 'radius', center, meters }`. A network
 * that wants different ones passes them rather than inheriting this guess.
 */
export const DEFAULT_RADIUS_PRESETS_KM = [5, 10, 25] as const;

/** #644 QA: whole numbers only, and a range a real search could mean. */
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 500;

export interface AreaSelectProps {
  value: BrowseArea;
  /**
   * The centre offered when the user picks a radius — the resolved viewer
   * location. #644: the CENTRE OFFERED, never an implicit filter; the list is
   * unbounded until the user chooses. Null when no location resolves, in
   * which case every radius option is hidden.
   */
  defaultCenter: { lat: number; lng: number } | null;
  /**
   * The map's current bounds, when it has reported any. Null hides the
   * viewport option entirely rather than offering a dead one — "the area
   * shown on the map" is meaningless before a map has been shown, and hiding
   * beats disabling here for the same reason it does for domains (spec D7a).
   */
  viewportBounds?: { minLat: number; minLng: number; maxLat: number; maxLng: number } | null;
  presetsKm?: readonly number[];
  onChange: (next: BrowseArea) => void;
}

/**
 * The area selector (#644 §3.1).
 *
 * Showing "Anywhere" as the current state is half the point of this control:
 * it makes the fix *legible*. Before #644 every signed-in viewer's list was
 * silently bounded to ~30 km with nothing on screen saying so. Now the absence
 * of a bound is visible, and a bound exists only because the user asked.
 *
 * Purpose-built rather than an `OptionSelect`: the custom-distance row is an
 * input with its own commit and clear affordances, and teaching the shared
 * option list to host one would complicate the Sort control that also uses it.
 */
export function AreaSelect({
  value,
  defaultCenter,
  viewportBounds = null,
  presetsKm = DEFAULT_RADIUS_PRESETS_KM,
  onChange,
}: Readonly<AreaSelectProps>) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  const km = (meters: number) => Math.round(meters / 1000);
  const displayLabel = (() => {
    switch (value.mode) {
      case 'radius':
        return t('browse.area_radius', { km: km(value.meters) });
      case 'viewport':
        return t('browse.area_viewport');
      default:
        return t('browse.area_anywhere');
    }
  })();

  const commitRadius = (kmValue: number) => {
    if (!defaultCenter) return;
    onChange({ mode: 'radius', center: defaultCenter, meters: kmValue * 1000 });
    setOpen(false);
    setCustomOpen(false);
    setDraft('');
  };

  const parsedDraft = draft === '' ? null : Number(draft);
  const draftValid =
    parsedDraft !== null && parsedDraft >= MIN_RADIUS_KM && parsedDraft <= MAX_RADIUS_KM;

  const rowClass =
    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs pointer-coarse:min-h-11 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reopening should not resume a half-typed value from last time.
        if (!next) {
          setCustomOpen(false);
          setDraft('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-normal text-muted-foreground">{t('browse.area_label')}</span>
          <span className="truncate font-semibold">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-64 p-1">
        <div role="listbox" aria-label={t('browse.area_label')}>
          <button
            type="button"
            role="option"
            aria-selected={value.mode === 'anywhere'}
            className={rowClass}
            onClick={() => {
              onChange(DEFAULT_BROWSE_AREA);
              setOpen(false);
            }}
          >
            <Check
              className={cn('h-3 w-3 shrink-0', value.mode === 'anywhere' ? 'opacity-100' : 'opacity-0')}
            />
            <span className="font-semibold">{t('browse.area_anywhere')}</span>
          </button>

          {viewportBounds && (
            <button
              type="button"
              role="option"
              aria-selected={value.mode === 'viewport'}
              className={rowClass}
              onClick={() => {
                onChange({ mode: 'viewport', bounds: viewportBounds });
                setOpen(false);
              }}
            >
              <Check
                className={cn('h-3 w-3 shrink-0', value.mode === 'viewport' ? 'opacity-100' : 'opacity-0')}
              />
              <span className="font-semibold">{t('browse.area_viewport')}</span>
            </button>
          )}

          {/* Radius options need a centre to measure from. Hidden rather than
              disabled when none resolves — the same hide-don't-disable call
              made for domains (spec D7a). */}
          {defaultCenter && (
            <>
              <div className="my-1 h-px bg-border" role="none" />
              {presetsKm.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  role="option"
                  aria-selected={value.mode === 'radius' && km(value.meters) === preset}
                  className={rowClass}
                  onClick={() => commitRadius(preset)}
                >
                  <Check
                    className={cn(
                      'h-3 w-3 shrink-0',
                      value.mode === 'radius' && km(value.meters) === preset
                        ? 'opacity-100'
                        : 'opacity-0',
                    )}
                  />
                  <span className="font-semibold">{t('browse.area_radius', { km: preset })}</span>
                </button>
              ))}

              <button
                type="button"
                aria-expanded={customOpen}
                className={rowClass}
                onClick={() => setCustomOpen((v) => !v)}
              >
                <span className="h-3 w-3 shrink-0" aria-hidden />
                <span className="font-semibold">{t('browse.area_custom')}</span>
              </button>

              {customOpen && (
                <div className="px-2 pb-2 pt-1">
                  {/* Commit (✓) and clear (✕) live INSIDE the field, and
                      nothing is applied until commit. That is also what keeps
                      the request and cache keys sane: a per-keystroke value
                      would issue a request — and a distinct cache entry, here
                      and in Redis — for every intermediate number. */}
                  <div className="flex items-center gap-1 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      aria-label={t('browse.area_custom_label', {
                        min: MIN_RADIUS_KM,
                        max: MAX_RADIUS_KM,
                      })}
                      value={draft}
                      onChange={(e) => {
                        // Digits only. Decimals are BLOCKED rather than
                        // rounded, so the value shown is always the value that
                        // would be applied — rounding "12.5" to 13 would mean
                        // the field and the request disagree mid-edit.
                        setDraft(e.target.value.replace(/\D/g, '').slice(0, 3));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && draftValid) {
                          e.preventDefault();
                          commitRadius(parsedDraft);
                        }
                      }}
                      className="h-9 w-full min-w-0 bg-transparent text-xs outline-none"
                      placeholder={String(MIN_RADIUS_KM)}
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t('browse.area_km_unit')}
                    </span>
                    <button
                      type="button"
                      aria-label={t('browse.area_custom_clear')}
                      onClick={() => setDraft('')}
                      disabled={draft === ''}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('browse.area_custom_apply')}
                      onClick={() => draftValid && commitRadius(parsedDraft)}
                      disabled={!draftValid}
                      className="shrink-0 rounded p-1 text-primary hover:bg-accent disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {draft !== '' && !draftValid && (
                    <p role="alert" className="mt-1 text-[10px] text-destructive">
                      {t('browse.area_custom_range', {
                        min: MIN_RADIUS_KM,
                        max: MAX_RADIUS_KM,
                      })}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
