import {
  BedDouble,
  Palette,
  Compass,
  ShoppingBag,
  Sparkles,
  MapPin,
  type LucideIcon,
} from 'lucide-react';
import type { MapMarker } from '@/engine/types';

/**
 * orange_dot practitioner `category` enum → map marker icon. The category enum
 * is defined in examples/schemas/orange_dot/network.json:
 *   Stay | Artists | Activities | GI Products | Curated
 */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Stay: BedDouble,
  Artists: Palette,
  Activities: Compass,
  'GI Products': ShoppingBag,
  Curated: Sparkles,
};

/** Icon used when a practitioner has no/unknown category. */
export const CATEGORY_FALLBACK_ICON: LucideIcon = MapPin;

/** Resolve a lucide icon for a category value (anything non-string → fallback). */
export function iconForCategory(category: unknown): LucideIcon {
  if (typeof category === 'string' && CATEGORY_ICONS[category]) {
    return CATEGORY_ICONS[category];
  }
  return CATEGORY_FALLBACK_ICON;
}

/**
 * Per-marker icon resolver for the tourist map: picks the icon from the
 * practitioner's `category` field rather than the (single) domain. Passed to
 * MapView as `resolveMarkerIcon`.
 */
export function resolvePractitionerIcon(marker: MapMarker): LucideIcon {
  return iconForCategory(marker.data.category);
}
