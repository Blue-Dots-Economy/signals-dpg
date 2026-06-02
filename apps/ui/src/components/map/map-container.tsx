import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { MapMarker } from '@/engine/types';
import { getActiveMapProvider } from '@/engine/map/map-registry';
import { extractAddressFromForm, extractPincodeFromForm, normalizeFieldName } from '@/lib/item-utils';
import { geocodePincode, geocodeAddress, geocodeAddressWithGoogle } from './geocoding';
import { Button } from '@/components/ui/button';
import { Maximize2, Minimize2 } from 'lucide-react';

interface MapViewProps {
  schema: RJSFSchema;
  /**
   * Items to render as markers. `domain` is the item's domain string (e.g.
   * "seeker", "provider") and is threaded to `MapMarker.domain` so each
   * provider can render a domain-specific icon. It is intentionally kept
   * outside of `data` so it never appears in the popup's data display.
   */
  items: Array<{ id: string; domain?: string; data: Record<string, unknown> }>;
  onMarkerClick?: (id: string) => void;
  center?: [number, number];
  zoom?: number;
  /**
   * The currently active/selected profile's coordinates. When present, the map
   * centers on this point (city-level zoom) instead of fitting all markers.
   * Driven by the active profile selected in the sidebar — switching profiles
   * re-centers the map. When null (no active profile, or it has no coords) the
   * map falls back to the default view and fits all markers.
   */
  focusPoint?: { lat: number; lng: number } | null;
  /**
   * The Filters control. Rendered inside the map overlay ONLY when the map is
   * maximized (in normal mode the page header hosts it, but that header is
   * covered when the map goes fullscreen, so we surface it here too).
   */
  filtersSlot?: React.ReactNode;
}

const INDIA_CENTER: [number, number] = [20.5937, 78.9629];
const INDIA_ZOOM = 5;
const PROFILE_ZOOM = 12;

export function MapView({
  schema,
  items,
  onMarkerClick,
  center = INDIA_CENTER,
  zoom = INDIA_ZOOM,
  focusPoint,
  filtersSlot,
}: MapViewProps) {
  const { t } = useTranslation();
  const MapProviderComponent = getActiveMapProvider();
  const [markers, setMarkers] = React.useState<MapMarker[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [isMaximized, setIsMaximized] = React.useState(false);

  // When toggling maximize, the map container changes size. Both Leaflet and
  // Google Maps listen for window 'resize' to re-fit their canvas, so dispatch
  // one after the DOM updates.
  React.useEffect(() => {
    const id = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
    return () => window.clearTimeout(id);
  }, [isMaximized]);

  // Allow Esc to exit maximized mode.
  React.useEffect(() => {
    if (!isMaximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMaximized]);

  // ── Effective center / zoom / initialViewSet ──────────────────────────────
  // When an active profile with coordinates is selected, center on it at
  // city-level zoom. Otherwise fall back to the caller-supplied center/zoom
  // (INDIA_CENTER default) and let FitBounds fit all markers.
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

  // ── Marker resolution ─────────────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;

    async function resolveMarkers() {
      setLoading(true);
      const titleField = findTitleField(schema);

      const resolved = await Promise.all(
        items.map(async (item) => {
          let lat: number | null = null;
          let lng: number | null = null;
          let precision: MapMarker['precision'] = 'exact';
          let geocodedFrom: string | undefined;

          // 1. Try stored coordinates first (exact precision)
          lat = resolveCoordinate(item.data, 'item_latitude', 'lat', 'latitude');
          lng = resolveCoordinate(item.data, 'item_longitude', 'lng', 'lon', 'longitude');

          // 2. Fallback to pincode geocoding
          if (lat === null || lng === null) {
            const pincode = extractPincodeFromForm(item.data, '');
            if (pincode) {
              const geo = await geocodePincode(pincode);
              if (geo) {
                lat = geo.lat;
                lng = geo.lng;
                precision = 'geocoded_pincode';
                geocodedFrom = 'pincode';
              }
            }
          }

          // 3. Fallback to address geocoding (full address format)
          if (lat === null || lng === null) {
            const address = extractAddressFromForm(item.data);
            if (address) {
              const geo = await geocodeAddressWithGoogle(address) ?? await geocodeAddress(address, 'full');
              if (geo) {
                lat = geo.lat;
                lng = geo.lng;
                precision = 'geocoded_full_address';
                geocodedFrom = 'location';
              } else {
                // Fallback to city-only format
                const cityGeo = await geocodeAddress(address, 'city-only');
                if (cityGeo) {
                  lat = cityGeo.lat;
                  lng = cityGeo.lng;
                  precision = 'geocoded_city_only';
                  geocodedFrom = 'city';
                }
              }
            }
          }

          // Skip items without any location data
          if (lat === null || lng === null) return null;

          const label = titleField
            ? String(item.data[titleField] ?? 'Item')
            : 'Item';

          return {
            id: item.id,
            lat,
            lng,
            label,
            data: item.data,
            precision,
            geocodedFrom,
            domain: item.domain,
          } satisfies MapMarker;
        })
      );

      if (!cancelled) {
        const valid = resolved.filter((m): m is NonNullable<typeof m> & MapMarker => m !== null);
        setMarkers(spreadCoLocatedMarkers(valid));
        setLoading(false);
      }
    }

    resolveMarkers();
    return () => { cancelled = true; };
  }, [items, schema]);

  // The map and the maximize button always render. Loading and empty states are
  // shown as overlays ON TOP of the map rather than replacing it — otherwise a
  // filter that yields zero markers would remove the map, leaving the user with
  // nothing. The overlay lives in the same wrapper that gets maximized, so the
  // control stays visible in maximized mode (unlike the provider's native
  // fullscreen). The Filters control lives in the page header, not here.
  return (
    <div
      className={
        isMaximized
          ? 'fixed inset-0 z-[2000] bg-background'
          : 'relative h-[calc(100vh-8rem)] min-h-[400px]'
      }
    >
      <MapProviderComponent
        center={effectiveCenter}
        zoom={effectiveZoom}
        markers={markers}
        onMarkerClick={onMarkerClick}
        initialViewSet={initialViewSet}
      />
      {/* Top-right overlay: Filters (only while maximized — the page header
          hosts it normally but is hidden in fullscreen) + maximize toggle.
          Placed top-right to avoid the providers' top-left controls. */}
      <div className="absolute right-2 top-2 z-[1000] flex items-center gap-2">
        {isMaximized && filtersSlot}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/95 shadow-md backdrop-blur-sm"
          onClick={() => setIsMaximized((v) => !v)}
          aria-label={isMaximized ? t('map.minimize') : t('map.maximize')}
          title={isMaximized ? t('map.minimize') : t('map.maximize')}
        >
          {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>
      {/* Loading / empty-state overlays (non-blocking, centered) */}
      {(loading || markers.length === 0) && (
        <div className="pointer-events-none absolute inset-0 z-[900] flex items-center justify-center">
          <p className="rounded-md bg-background/90 px-4 py-2 text-sm text-muted-foreground shadow-md backdrop-blur-sm">
            {loading
              ? t('map.loading')
              : t('map.no_results')}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Many items geocode to the EXACT same coordinate (e.g. every "Bengaluru"
 * profile lands on the city centroid). Markers stacked on one pixel can't be
 * told apart or individually clicked once a cluster is expanded — and the
 * Google Maps clusterer (unlike Leaflet) has no spiderfy. To make every item
 * reachable on both providers, we deterministically fan out any group of
 * markers that share identical coordinates onto a small circle (~15m radius).
 *
 * This is effectively a permanent, provider-agnostic spiderfy: zoomed out the
 * points are close enough to still cluster into a count; zoomed in they
 * separate into individually-clickable pins. The offset is tiny relative to a
 * city-centroid's inherent imprecision, so it does not misrepresent location.
 */
function spreadCoLocatedMarkers(markers: MapMarker[]): MapMarker[] {
  // ~15 metres expressed in degrees of latitude (1° lat ≈ 111_320 m).
  const RADIUS_DEG = 15 / 111_320;

  const groups = new Map<string, MapMarker[]>();
  for (const marker of markers) {
    const key = `${marker.lat.toFixed(6)},${marker.lng.toFixed(6)}`;
    const group = groups.get(key);
    if (group) group.push(marker);
    else groups.set(key, [marker]);
  }

  const result: MapMarker[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Evenly distribute the group around a small circle centered on the
    // shared coordinate. Longitude offset is scaled by cos(lat) so the spread
    // stays roughly circular on the ground.
    const n = group.length;
    const latRad = (group[0].lat * Math.PI) / 180;
    const lngScale = Math.max(Math.cos(latRad), 0.01);
    group.forEach((marker, i) => {
      const angle = (2 * Math.PI * i) / n;
      result.push({
        ...marker,
        lat: marker.lat + RADIUS_DEG * Math.cos(angle),
        lng: marker.lng + (RADIUS_DEG * Math.sin(angle)) / lngScale,
      });
    });
  }

  return result;
}

function resolveCoordinate(
  data: Record<string, unknown>,
  ...keys: string[]
): number | null {
  const normalizedKeys = keys.map(normalizeFieldName);
  for (const key of keys) {
    const val = data[key];
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const num = parseFloat(val);
      if (!isNaN(num)) return num;
    }
  }

  for (const [key, val] of Object.entries(data)) {
    if (!normalizedKeys.includes(normalizeFieldName(key))) continue;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const num = parseFloat(val);
      if (!isNaN(num)) return num;
    }
  }

  return null;
}

function findTitleField(schema: RJSFSchema): string | null {
  if (!schema.properties) return null;

  // Prefer the schema's own declared display field (network configs set
  // `display_name_field` per item schema, e.g. "jobProviderName", "Full Name").
  // This is the generic, network-agnostic source of truth.
  const declared = (schema as Record<string, unknown>)['display_name_field'];
  if (typeof declared === 'string' && declared in schema.properties) {
    return declared;
  }

  // Fall back to common generic title field names (no domain-specific names).
  const candidates = ['name', 'full_name', 'display_name', 'title', 'label'];
  for (const key of candidates) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}
