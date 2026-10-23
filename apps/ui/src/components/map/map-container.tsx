import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { MapMarker, MapViewport } from '@/engine/types';
import { getActiveMapProvider } from '@/engine/map/map-registry';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { Button } from '@/components/ui/button';
import { Maximize2, Minimize2 } from 'lucide-react';

interface MapViewProps {
  schema: RJSFSchema;
  /**
   * Items to render as markers. `domain` feeds `MapMarker.domain` for
   * domain-specific icons; it sits outside `data` so the popup never displays
   * it.
   */
  items: Array<{ id: string; domain?: string; data: Record<string, unknown> }>;
  onMarkerClick?: (id: string) => void;
  /**
   * Like `onMarkerClick`, but receives the whole rendered marker (id with its
   * `#locationIndex` suffix), for callers that show details with `showPopup`
   * off.
   */
  onMarkerSelect?: (marker: MapMarker) => void;
  /** Draw the provider's own popup on marker click. Default true. */
  showPopup?: boolean;
  center?: [number, number];
  zoom?: number;
  /**
   * The viewer's resolved location (profile or browser). When present the map
   * centres on it at city-level zoom; when null it uses `center`/`zoom` and
   * fits all markers.
   */
  focusPoint?: { lat: number; lng: number } | null;
  /**
   * Monotonic counter bumped on an explicit recenter intent (e.g. the user
   * picks a location source). Forwarded to the provider so the map snaps back
   * to `focusPoint` even when the coordinate is unchanged and the user panned.
   */
  focusNonce?: number;
  /**
   * Monotonic counter bumped to close any open marker popup (e.g. before an
   * action modal opens), since on mobile the popup would otherwise cover a
   * bottom-sheet modal.
   */
  closePopupNonce?: number;
  /** Where the provider draws the "You are here" self-marker; none when null. */
  selfLocation?: { lat: number; lng: number } | null;
  /**
   * The Filters control, rendered in the map overlay only while maximized,
   * because the browse toolbar that normally hosts it is covered then.
   */
  filtersSlot?: React.ReactNode;
  /** The location-source control; shown while maximized, like `filtersSlot`. */
  locationSlot?: React.ReactNode;
  /** Optional custom popup renderer passed to the active provider. */
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  /**
   * Per-item marker label, so each domain's `card.title_field` is honoured
   * when items span domains. Undefined falls back to the schema heuristic.
   */
  resolveMarkerLabel?: (item: {
    id: string;
    domain?: string;
    data: Record<string, unknown>;
  }) => string | undefined;
  /** Tailwind height classes for the non-maximized wrapper. */
  heightClassName?: string;
  /** Per-marker icon resolver; the provider defaults to a domain-based icon. */
  resolveMarkerIcon?: (marker: MapMarker) => import('lucide-react').LucideIcon;
  /** When this returns a URL the marker renders as that image, not the icon pin. */
  resolveMarkerImage?: (marker: MapMarker) => string | null | undefined;
  /**
   * Called by the provider on debounced pan/zoom settle with the viewport
   * (see `useViewportReport`). Unset means no listener is attached.
   */
  onViewportChange?: (viewport: MapViewport) => void;
  /**
   * Overrides the empty-state text. A viewport-scoped map means "none in this
   * area", not "filtered out", so the home page passes an area message.
   */
  emptyMessage?: string;
}

// Default map view when the viewer has no location. Set per deployment, not
// per network, because one network can run as separate regional instances:
//   VITE_MAP_DEFAULT_CENTER = "lat,lng"
//   VITE_MAP_DEFAULT_ZOOM   = number
// Falls back to a whole-India view when unset or invalid.
//
// Read via `getRuntimeEnv` (runtime /config.js first, then build-time), since
// the published UI image is built without VITE_ args.
export const FALLBACK_CENTER: [number, number] = [20.5937, 78.9629];
export const FALLBACK_ZOOM = 5;

export function parseDefaultCenter(raw: string | undefined): [number, number] {
  const parts = (raw ?? '').split(',').map((s) => Number(s.trim()));
  const [lat, lng] = parts;
  const valid =
    parts.length === 2 &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;
  return valid ? [lat, lng] : FALLBACK_CENTER;
}

export function parseDefaultZoom(raw: string | undefined): number {
  const z = Number(raw);
  return Number.isFinite(z) && z > 0 && z <= 22 ? z : FALLBACK_ZOOM;
}

export const DEFAULT_CENTER: [number, number] = parseDefaultCenter(
  getRuntimeEnv('VITE_MAP_DEFAULT_CENTER'),
);
export const DEFAULT_ZOOM = parseDefaultZoom(getRuntimeEnv('VITE_MAP_DEFAULT_ZOOM'));
const PROFILE_ZOOM = 12;

export function MapView({
  schema,
  items,
  onMarkerClick,
  onMarkerSelect,
  showPopup = true,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  focusPoint,
  focusNonce,
  closePopupNonce,
  selfLocation,
  filtersSlot,
  locationSlot,
  renderPopup,
  resolveMarkerLabel,
  heightClassName = 'h-[calc(100dvh-8rem)] min-h-[400px]',
  resolveMarkerIcon,
  resolveMarkerImage,
  onViewportChange,
  emptyMessage,
}: MapViewProps) {
  const { t } = useTranslation();
  const MapProviderComponent = getActiveMapProvider();
  const [markers, setMarkers] = React.useState<MapMarker[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [isMaximized, setIsMaximized] = React.useState(false);

  // Maximize changes the container size; dispatch a window 'resize' after the
  // DOM updates so the provider re-fits its canvas.
  React.useEffect(() => {
    const id = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
    return () => window.clearTimeout(id);
  }, [isMaximized]);

  React.useEffect(() => {
    if (!isMaximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMaximized]);

  // With a focus point, centre on it at city zoom; otherwise use the caller's
  // center/zoom and let FitBounds fit all markers.
  const { effectiveCenter, effectiveZoom, initialViewSet } = React.useMemo(() => {
    if (!focusPoint) {
      return { effectiveCenter: center, effectiveZoom: zoom, initialViewSet: false };
    }
    return {
      effectiveCenter: [focusPoint.lat, focusPoint.lng] as [number, number],
      effectiveZoom: PROFILE_ZOOM,
      initialViewSet: true,
    };
  }, [focusPoint, center, zoom]);

  React.useEffect(() => {
    let cancelled = false;

    async function resolveMarkers() {
      setLoading(true);
      const titleField = findTitleField(schema);

      const resolved = await Promise.all(
        items.map((item) => {
          // One marker per stored `item_locations` entry.
          const locs = Array.isArray(
            (item.data as Record<string, unknown>).item_locations
          )
            ? (
                item.data as {
                  item_locations?: Array<{ lat: number; lng: number; label?: string }>;
                }
              ).item_locations ?? []
            : [];

          // Locations are resolved server-side; the browser does not geocode
          // (its Maps key is scoped to Maps JS and Places). Items with no stored
          // location produce no marker.
          const points: Array<{ lat: number; lng: number; label?: string }> = locs;

          if (points.length === 0) return [];

          // Per-domain title first, then the single-schema heuristic, then 'Item'.
          const resolvedLabel = resolveMarkerLabel?.(item)?.trim();
          const baseLabel =
            resolvedLabel ||
            (titleField ? String(item.data[titleField] ?? 'Item') : 'Item');

          const precision: MapMarker['precision'] = 'exact';

          return points.map(
            (p, i) =>
              ({
                id: `${item.id}#${i}`,
                lat: p.lat,
                lng: p.lng,
                label: p.label ? `${baseLabel} — ${p.label}` : baseLabel,
                data: item.data,
                precision,
                geocodedFrom: undefined,
                domain: item.domain,
              }) satisfies MapMarker
          );
        })
      );

      if (!cancelled) {
        const valid: MapMarker[] = resolved.flat();
        setMarkers(spreadCoLocatedMarkers(valid, selfLocation ?? null));
        setLoading(false);
      }
    }

    void resolveMarkers();
    return () => { cancelled = true; };
  }, [items, schema, resolveMarkerLabel, selfLocation]);

  // Loading and empty states overlay the map rather than replacing it, so zero
  // markers never removes the map. The overlay is inside the maximized
  // wrapper, so its controls stay visible when maximized.
  return (
    <div
      className={
        isMaximized
          ? 'fixed inset-0 z-[2000] bg-background'
          : // `isolate` contains Leaflet's panes (z-index 200-700) so they
            // cannot paint above Radix dialogs (z-50).
            `relative isolate ${heightClassName}`
      }
    >
      <MapProviderComponent
        center={effectiveCenter}
        zoom={effectiveZoom}
        markers={markers}
        // Passes a handler only when the caller gave one: the default popup
        // shows a "View details" link exactly when `onMarkerClick` is set.
        onMarkerClick={
          onMarkerSelect
            ? (id) => {
                onMarkerClick?.(id);
                const marker = markers.find((m) => m.id === id);
                if (marker) onMarkerSelect(marker);
              }
            : onMarkerClick
        }
        showPopup={showPopup}
        initialViewSet={initialViewSet}
        focusNonce={focusNonce}
        closePopupNonce={closePopupNonce}
        selfLocation={selfLocation ?? null}
        renderPopup={renderPopup}
        resolveIcon={resolveMarkerIcon}
        resolveMarkerImage={resolveMarkerImage}
        onViewportChange={onViewportChange}
      />
      {/* Top-right, clear of the providers' top-left controls. */}
      <div className="absolute right-2 top-2 z-[1000] flex items-center gap-2">
        {isMaximized && locationSlot}
        {isMaximized && filtersSlot}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/95 shadow-md backdrop-blur-sm"
          data-tour="map-maximize"
          onClick={() => setIsMaximized((v) => !v)}
          aria-label={isMaximized ? t('map.minimize') : t('map.maximize')}
          title={isMaximized ? t('map.minimize') : t('map.maximize')}
        >
          {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>
      {/* Loading / empty-state overlay */}
      {(loading || markers.length === 0) && (
        <div className="pointer-events-none absolute inset-0 z-[900] flex items-center justify-center">
          <p className="rounded-md bg-background/90 px-4 py-2 text-sm text-muted-foreground shadow-md backdrop-blur-sm">
            {loading
              ? t('map.loading')
              : (emptyMessage ?? t('map.no_results'))}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Stable hash of a string to [0, 1) (FNV-1a, 32-bit), so a marker's fan-out
 * angle depends only on its id. Iterates code points with `for...of`; an
 * index loop with `codePointAt` would double-read surrogate pairs.
 */
function hashToUnit(str: string): number {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Fans markers that share an exact coordinate onto a ~10 m circle so each is
 * clickable on both providers (the Google Maps clusterer has no spiderfy).
 * Zoomed out they still cluster; the offset is small next to city-centroid
 * imprecision.
 *
 * `selfLocation` counts as a virtual group member: a single item on the
 * viewer's own coordinate is also fanned out, so it is not hidden under the
 * "You are here" marker. The self-marker itself never moves.
 */
export function spreadCoLocatedMarkers(
  markers: MapMarker[],
  selfLocation?: { lat: number; lng: number } | null,
): MapMarker[] {
  // ~10 metres expressed in degrees of latitude (1° lat ≈ 111_320 m).
  const RADIUS_DEG = 10 / 111_320;

  const groups = new Map<string, MapMarker[]>();
  for (const marker of markers) {
    const key = `${marker.lat.toFixed(6)},${marker.lng.toFixed(6)}`;
    const group = groups.get(key);
    if (group) group.push(marker);
    else groups.set(key, [marker]);
  }

  const selfKey = selfLocation
    ? `${selfLocation.lat.toFixed(6)},${selfLocation.lng.toFixed(6)}`
    : null;

  const result: MapMarker[] = [];
  for (const [key, group] of groups) {
    const isAtSelfLocation = selfKey !== null && key === selfKey;
    if (group.length === 1 && !isAtSelfLocation) {
      result.push(group[0]);
      continue;
    }
    // The angle depends only on the marker id, so a pin does not move when
    // filters change. Longitude is scaled by cos(lat) to stay circular.
    const latRad = (group[0].lat * Math.PI) / 180;
    const lngScale = Math.max(Math.cos(latRad), 0.01);
    for (const marker of group) {
      const angle = hashToUnit(marker.id) * 2 * Math.PI;
      result.push({
        ...marker,
        lat: marker.lat + RADIUS_DEG * Math.cos(angle),
        lng: marker.lng + (RADIUS_DEG * Math.sin(angle)) / lngScale,
      });
    }
  }

  return result;
}


function findTitleField(schema: RJSFSchema): string | null {
  if (!schema.properties) return null;

  // Prefer the schema's declared `display_name_field`.
  const declared = (schema as Record<string, unknown>)['display_name_field'];
  if (typeof declared === 'string' && declared in schema.properties) {
    return declared;
  }

  const candidates = ['name', 'full_name', 'display_name', 'title', 'label'];
  for (const key of candidates) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}
