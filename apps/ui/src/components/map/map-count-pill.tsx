import { useTranslation } from 'react-i18next';
import { ZoomIn } from 'lucide-react';

export interface MapCountPillProps {
  /** The true count of matches in the current viewport (`meta.total`), regardless of the fetch cap. */
  total: number;
  /** Number of markers actually rendered into view (after any client-side domain narrowing). */
  shown: number;
  /** Whether `total` exceeds the zoom-band marker cap (`useMapMarkers`'s `truncated`). */
  truncated: boolean;
}

/**
 * The map's viewport count, the only place that number appears; the browse
 * toolbar shows the filter total regardless of location. Shown to all
 * visitors.
 *
 * - Over-dense ("N+ in this area, zoom in") when the viewport total exceeds
 *   the zoom-band marker cap. Zooming in refetches and clears `truncated`.
 * - Otherwise "Showing X of Y" when some matches are not rendered (the
 *   viewer's own items are excluded), else "Y listings".
 */
export function MapCountPill({ total, shown, truncated }: Readonly<MapCountPillProps>) {
  const { t } = useTranslation();

  if (total <= 0) return null;

  const label = truncated
    ? t('home.map_zoom_in_for_more', { count: total })
    : shown < total
      ? t('home.showing_x_of_y', { shown, total })
      : t('header.listings', { count: total });

  // High-contrast solid chip so it is legible over any basemap.
  return (
    // z-[2100] keeps the pill above the maximized map (z-[2000]) but also
    // above dialogs and sheets (z-[1200]), so it hides while <body> carries
    // Radix/vaul's `data-scroll-locked`, i.e. while any modal is open.
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[2100] -translate-x-1/2 px-4 in-data-[scroll-locked]:hidden">
      <div data-tour="map-count" className="flex items-center gap-1.5 rounded-full bg-slate-900/95 px-3.5 py-2 text-xs font-semibold text-white shadow-lg ring-1 ring-white/20 backdrop-blur-sm">
        {truncated && <ZoomIn className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        {label}
      </div>
    </div>
  );
}
