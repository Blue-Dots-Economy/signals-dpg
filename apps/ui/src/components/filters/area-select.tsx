import { useTranslation } from 'react-i18next';
import { OptionSelect } from './option-select';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea } from '@/lib/browse-discover';

/** Offered radii, metres. Kept here so the chip copy and the options agree. */
export const RADIUS_OPTIONS_METERS = [5000, 10000, 25000, 50000] as const;

export interface AreaSelectProps {
  value: BrowseArea;
  /**
   * The centre offered when the user picks a radius — the resolved viewer
   * location. #644: this is the CENTRE OFFERED, never an implicit filter; the
   * list is unbounded until the user chooses a radius. Null when no location
   * resolves, in which case the radius options are unavailable.
   */
  defaultCenter: { lat: number; lng: number } | null;
  onChange: (next: BrowseArea) => void;
}

/**
 * The area selector (#644 §3.1).
 *
 * Showing "Anywhere" as the current state is half the point of this control:
 * it makes the fix *legible*. Before #644 every signed-in viewer's list was
 * silently bounded to ~30 km with nothing on screen saying so. Now the absence
 * of a bound is visible, and a bound only exists because the user asked for it.
 *
 * `viewport` mode was specified and then dropped (spec D6): signals-search has
 * no bbox operator, so a map rectangle would have to be approximated by its
 * circumscribed circle and the list would include items that were off the
 * edges of the map. `radius` serves the real need.
 */
export function AreaSelect({ value, defaultCenter, onChange }: Readonly<AreaSelectProps>) {
  const { t } = useTranslation();

  const km = (meters: number) => Math.round(meters / 1000);
  const displayLabel =
    value.mode === 'radius'
      ? t('browse.area_radius', { km: km(value.meters) })
      : t('browse.area_anywhere');

  // Values are strings so they can key the OptionSelect: 'anywhere' plus one
  // per radius.
  type AreaValue = 'anywhere' | `r${number}`;
  const currentValue: AreaValue = value.mode === 'radius' ? `r${value.meters}` : 'anywhere';

  return (
    <OptionSelect<AreaValue>
      name={t('browse.area_label')}
      displayLabel={displayLabel}
      value={currentValue}
      onChange={(next) => {
        if (next === 'anywhere') {
          onChange(DEFAULT_BROWSE_AREA);
          return;
        }
        const meters = Number(next.slice(1));
        // Guarded rather than assumed: without a centre there is no radius to
        // apply, and silently doing nothing would look like a broken control.
        if (!defaultCenter) return;
        onChange({ mode: 'radius', center: defaultCenter, meters });
      }}
      options={[
        { value: 'anywhere', label: t('browse.area_anywhere') },
        ...RADIUS_OPTIONS_METERS.map((meters) => ({
          value: `r${meters}` as AreaValue,
          label: t('browse.area_radius', { km: km(meters) }),
          available: defaultCenter !== null,
          reason: defaultCenter ? undefined : t('browse.area_radius_unavailable'),
        })),
      ]}
    />
  );
}
