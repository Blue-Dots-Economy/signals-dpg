import { useTranslation } from 'react-i18next';
import { ZoomIn } from 'lucide-react';

export interface MapCountPillProps {
  /** The true count of matches in the current viewport (`meta.total`), regardless of the fetch cap. */
  total: number;
  /** Number of markers actually rendered into view (after any client-side domain narrowing). */
  shown: number;
  /** Whether `total` exceeds the active zoom-band marker cap (#203 map-serverside-search Task 6, `useMapMarkers`'s `truncated`). */
  truncated: boolean;
  /** Whether a user is signed in. */
  signedIn: boolean;
}

/**
 * The map's bottom-center count pill (#203 map-serverside-search §7 revised,
 * extended by Task 6). Two mutually exclusive variants share the one pill
 * slot:
 *
 *  - **Over-dense** ("{{count}}+ in this area — zoom in"): shown for BOTH
 *    anonymous and signed-in visitors whenever the viewport's true total
 *    exceeds the active zoom-band marker cap. Zooming in (which refetches per
 *    Task 5's padded-bbox/truncated-result rule) drops the count under the
 *    cap on its own, so the pill disappears without any extra wiring here —
 *    it just stops being told `truncated`.
 *  - **Plain count** (signed-out only, unchanged from the original §7 pill):
 *    "Showing X of Y" / "Y listings" for a logged-out visitor's non-truncated
 *    view. Signed-in visitors already have the header's `ContentHeader`
 *    count, so this variant stays hidden for them — only the over-dense
 *    variant is new for signed-in visitors.
 */
export function MapCountPill({ total, shown, truncated, signedIn }: MapCountPillProps) {
  const { t } = useTranslation();

  if (total <= 0) return null;
  if (!truncated && signedIn) return null;

  const label = truncated
    ? t('home.map_zoom_in_for_more', { count: total })
    : shown < total
      ? t('home.showing_x_of_y', { shown, total })
      : t('header.listings', { count: total });

  // High-contrast solid chip so it's legible over any basemap (the old
  // near-background pill washed out against the light map). The over-dense
  // variant leads with a zoom-in icon to read as an actionable hint.
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[2100] -translate-x-1/2 px-4">
      <div className="flex items-center gap-1.5 rounded-full bg-slate-900/95 px-3.5 py-2 text-xs font-semibold text-white shadow-lg ring-1 ring-white/20 backdrop-blur-sm">
        {truncated && <ZoomIn className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        {label}
      </div>
    </div>
  );
}
