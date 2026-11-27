import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { OptionSelect } from './option-select';
import type { SelectOption } from './option-select';
import type { PreferredLocationSource } from '@/hooks/use-user-location';

export interface LocationSourceSelectProps {
  /** The source the viewer ASKED for. Ticks the list; may not be honoured. */
  value: PreferredLocationSource;
  /**
   * The source actually in force, which the trigger labels from. It differs
   * from `value` when the profile has no location: `preferredSource` stays
   * `profile` while `useUserLocation` resolves to `browser`.
   */
  effectiveValue: PreferredLocationSource;
  onChange: (next: PreferredLocationSource) => void;
  /** Whether each source can supply a coordinate at all. */
  profileAvailable: boolean;
  browserAvailable: boolean;
}

/**
 * The location-source half of `LocationSelect`, for the map. It decides where
 * the map opens (`focusPoint`), where "You are here" sits (`selfLocation`),
 * and re-centres the map on change (`focusNonce`). The radius is not offered
 * because the viewport is the map's spatial filter.
 *
 * Design: docs/architecture/ui-components-browse-controls.md
 */
export function LocationSourceSelect({
  value,
  effectiveValue,
  onChange,
  profileAvailable,
  browserAvailable,
}: Readonly<LocationSourceSelectProps>) {
  const { t } = useTranslation();

  const options: SelectOption<PreferredLocationSource>[] = [
    {
      value: 'profile',
      label: t('browse.location_from_profile'),
      available: profileAvailable,
      // `hint` on a choosable option, `reason` on an unavailable one —
      // OptionSelect shows one or the other, never both.
      hint: t('browse.location_profile_hint'),
      reason: t('browse.location_profile_unavailable'),
    },
    {
      value: 'browser',
      label: t('browse.location_from_browser'),
      available: browserAvailable,
      hint: t('browse.location_browser_hint'),
      reason: t('browse.location_browser_unavailable'),
    },
  ];

  return (
    <OptionSelect
      name={t('browse.location_label')}
      // The heading says this picks the map centre, so "Location: My profile"
      // is not misread as a filter on which pins are shown.
      heading={t('browse.location_map_centre')}
      // From the effective source, not the preference; see `effectiveValue`.
      displayLabel={
        effectiveValue === 'browser'
          ? t('browse.location_from_browser')
          : t('browse.location_from_profile')
      }
      icon={MapPin}
      // One mount point is the maximized map overlay, so the list must clear
      // its `z-[2000]`.
      aboveMaximizedMap
      options={options}
      value={value}
      onChange={onChange}
    />
  );
}
