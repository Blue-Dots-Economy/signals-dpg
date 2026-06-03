/// <reference types="google.maps" />
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import {
  AdvancedMarker,
  APIProvider,
  InfoWindow,
  Map,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import type { AdvancedMarkerRef } from '@vis.gl/react-google-maps';
import { MarkerClusterer, type Renderer, type Cluster } from '@googlemaps/markerclusterer';
import type { MapMarker, MapProviderProps } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { getIconForDomain } from '../domain-icons';
import { tallyDomains } from '../cluster-breakdown';
import { MarkerPopupCard } from '../marker-popup-card';
import { getRuntimeEnv } from '@/lib/runtime-env';

/**
 * Module-level WeakMap: AdvancedMarkerElement → domain string.
 * Populated by each ClusteredMarker when its underlying element becomes
 * available; read by the cluster renderer to tally per-domain counts.
 * WeakMap ensures entries are GC-eligible alongside the element object.
 */
const markerDomainMap = new WeakMap<object, string>();

/**
 * Resolves a CSS custom property (e.g. --primary) to a concrete rgb/hex string.
 * The theme stores --primary as an `oklch(...)` value; an SVG data-URI `fill`
 * needs a rasterizable colour, so we round-trip it through a canvas which
 * normalizes any CSS colour to rgb/hex.
 */
function resolveThemeColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.color = `var(${varName})`;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  if (!computed) return fallback;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return computed;
  ctx.fillStyle = fallback;
  ctx.fillStyle = computed; // canvas normalizes oklch → rgb if supported
  return ctx.fillStyle;
}

/**
 * Builds the cluster bubble as an HTML element (for AdvancedMarkerElement
 * content). Rendering as real HTML — rather than an SVG data-URI — lets the
 * lucide icons keep their stroke styling and lets the mini badges tuck neatly
 * under the main circle via flexbox, matching the intended design.
 *
 * A main circle shows the total (themed --primary background, white text). When
 * the cluster spans more than one domain, a row of small white chips below it
 * shows each domain's icon + count (sorted by count desc).
 */
function buildClusterContent(
  total: number,
  breakdown: Array<{ domain: string; count: number }>,
  primary: string,
): HTMLElement {
  const wrap = document.createElement('div');
  // AdvancedMarkerElement anchors content bottom-centre to the point; shift down
  // so the bubble sits roughly centred over the cluster location.
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;transform:translateY(50%);';

  const size = total < 10 ? 38 : total < 100 ? 44 : 50;
  const circle = document.createElement('div');
  circle.style.cssText =
    `display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;` +
    `background:${primary};color:#ffffff;border:2px solid #ffffff;border-radius:9999px;` +
    `box-shadow:0 1px 4px rgba(0,0,0,0.35);font:600 14px ui-sans-serif,system-ui,sans-serif;`;
  circle.textContent = String(total);
  wrap.appendChild(circle);

  if (breakdown.length > 1) {
    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:4px;margin-top:-8px;';
    for (const b of breakdown) {
      const Icon = getIconForDomain(b.domain);
      const iconSvg = renderToStaticMarkup(
        React.createElement(Icon, { size: 11, color: primary, strokeWidth: 2.4 }),
      );
      const chip = document.createElement('span');
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:3px;background:#ffffff;border:1px solid #e2e8f0;' +
        'border-radius:9999px;padding:2px 7px 2px 5px;font:600 11px ui-sans-serif,system-ui,sans-serif;' +
        'color:#1e293b;box-shadow:0 1px 2px rgba(0,0,0,0.18);line-height:1;';
      chip.innerHTML = `${iconSvg}<span>${b.count}</span>`;
      badges.appendChild(chip);
    }
    wrap.appendChild(badges);
  }

  return wrap;
}

/**
 * Custom cluster renderer so the cluster bubble uses the active network theme
 * colour (instead of the library's default blue) and shows a per-domain
 * breakdown. Returns an AdvancedMarkerElement with HTML content.
 */
const clusterRenderer: Renderer = {
  render(cluster: Cluster) {
    const { count, position, markers } = cluster;
    // Neutral gray fallback used only if --primary can't be resolved — must not
    // be a specific network's brand colour.
    const primary = resolveThemeColor('--primary', '#6b7280');

    // Tally domains from the clustered marker elements via the WeakMap.
    const domains = (markers ?? []).map((m) => markerDomainMap.get(m as object) ?? '');
    const breakdown = tallyDomains(domains);

    return new google.maps.marker.AdvancedMarkerElement({
      position,
      content: buildClusterContent(count, breakdown, primary),
      zIndex: 1000 + count,
    });
  },
};

// ─── Per-marker component ────────────────────────────────────────────────────
// Each ClusteredMarker calls useAdvancedMarkerRef() (legal — one hook per
// component instance) to obtain the underlying AdvancedMarkerElement, then
// reports it to the parent via onMarkerReady so the parent can register it
// with the MarkerClusterer instance.

interface ClusteredMarkerProps {
  marker: MapMarker;
  isActive: boolean;
  onClick: (marker: MapMarker) => void;
  onClose: () => void;
  onMarkerClick?: (id: string) => void;
  onMarkerReady: (id: string, el: NonNullable<AdvancedMarkerRef> | null) => void;
}

function ClusteredMarker({
  marker,
  isActive,
  onClick,
  onClose,
  onMarkerClick,
  onMarkerReady,
}: ClusteredMarkerProps) {
  const [markerRef, markerEl] = useAdvancedMarkerRef();
  const { id } = marker;

  // Resolve the domain icon once per render (cheap — just a lookup).
  const DomainIcon = getIconForDomain(marker.domain);

  // Report the underlying element to the parent each time it changes.
  // Also register this element→domain mapping so the cluster renderer can
  // look up each marker's domain when building the badge row.
  React.useEffect(() => {
    if (markerEl) {
      markerDomainMap.set(markerEl, marker.domain ?? '');
    }
    onMarkerReady(id, markerEl);
    // Cleanup: remove from clusterer when this marker unmounts.
    // WeakMap cleanup is automatic (GC) when markerEl is released.
    return () => {
      onMarkerReady(id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerEl, id]);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: marker.lat, lng: marker.lng }}
        title={marker.label}
        onClick={() => {
          // Toggle: clicking the already-open marker closes its popup.
          if (isActive) {
            onClose();
          } else {
            onClick(marker);
          }
          onMarkerClick?.(marker.id);
        }}
      >
        {/*
         * Render a custom circular marker as AdvancedMarker children rather
         * than using <Pin glyph={...}>. The vis.gl <Pin> glyph prop expects a
         * string/DOM element, so a React icon node silently fails to render
         * (showing a plain colored pin with no icon). A styled div child is
         * rendered reliably by vis.gl.
         *
         * Colour is network-derived: `bg-primary` / `text-primary-foreground`
         * resolve to the active network theme's --primary (blue_dot → blue,
         * purple_dot → purple, …) the same way the rest of the UI is themed.
         * The lucide icon inherits the foreground colour via currentColor.
         */}
        <div
          className="flex items-center justify-center rounded-full border-2 border-white bg-primary text-primary-foreground shadow-md"
          style={{ width: 30, height: 30 }}
        >
          <DomainIcon size={16} strokeWidth={2.5} />
        </div>
      </AdvancedMarker>
      {isActive && markerEl && (
        <InfoWindow
          anchor={markerEl}
          onCloseClick={onClose}
        >
          <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
        </InfoWindow>
      )}
    </>
  );
}

// ─── MapView controller component ────────────────────────────────────────────
// Lives inside <Map> so it can call useMap() from @vis.gl/react-google-maps.
// Imperatively pans/zooms the Google map when the caller provides an explicit
// viewport (e.g. when the user picks a different own profile from the selector).
// Only fires when `initialViewSet` is true; when false the map is in "fit all"
// mode and we leave it alone so it doesn't fight FitBounds or user panning.

interface MapViewControllerProps {
  center: [number, number];
  zoom: number;
  initialViewSet: boolean;
}

function MapViewController({ center, zoom, initialViewSet }: MapViewControllerProps) {
  const map = useMap();
  const prevCenter = React.useRef<[number, number] | null>(null);
  const prevZoom = React.useRef<number | null>(null);

  React.useEffect(() => {
    // Only drive the viewport when a specific profile is selected.
    if (!map || !initialViewSet) return;

    const sameCenter =
      prevCenter.current !== null &&
      prevCenter.current[0] === center[0] &&
      prevCenter.current[1] === center[1];
    const sameZoom = prevZoom.current === zoom;

    if (!sameCenter || !sameZoom) {
      map.panTo({ lat: center[0], lng: center[1] });
      map.setZoom(zoom);
    }

    prevCenter.current = center;
    prevZoom.current = zoom;
  }, [center, zoom, initialViewSet, map]);

  return null;
}

// ─── Clusterer manager component ─────────────────────────────────────────────
// Lives inside <Map> so it can call useMap() from @vis.gl/react-google-maps.
// Maintains a MarkerClusterer instance and keeps it in sync with the set of
// AdvancedMarkerElements reported by ClusteredMarker children.

interface ClustererManagerProps {
  markers: MapMarker[];
  activeMarkerId: string | null;
  onMarkerActivate: (marker: MapMarker) => void;
  onMarkerDeactivate: () => void;
  onMarkerClick?: (id: string) => void;
}

function ClustererManager({
  markers,
  activeMarkerId,
  onMarkerActivate,
  onMarkerDeactivate,
  onMarkerClick,
}: ClustererManagerProps) {
  const map = useMap();

  // Map from marker id → AdvancedMarkerElement
  const markerElsRef = React.useRef<globalThis.Map<string, NonNullable<AdvancedMarkerRef>>>(new globalThis.Map());

  // Stable ref to the MarkerClusterer instance
  const clustererRef = React.useRef<MarkerClusterer | null>(null);

  // Create the clusterer once the map is ready.
  React.useEffect(() => {
    if (!map) return;

    const clusterer = new MarkerClusterer({ map, renderer: clusterRenderer });
    clustererRef.current = clusterer;

    return () => {
      // clearMarkers() removes all pins from the clusterer, then setMap(null)
      // detaches the OverlayView from the map — the correct teardown sequence.
      // onRemove() is an internal OverlayView lifecycle callback and must NOT
      // be called directly as it can throw on unmount.
      // MarkerClusterer inherits setMap() at runtime through OverlayViewSafe
      // but the TypeScript class declaration doesn't surface it; cast to access
      // it without triggering the TS2339 "does not exist" error.
      clusterer.clearMarkers();
      (clusterer as unknown as { setMap: (map: null) => void }).setMap(null);
      clustererRef.current = null;
    };
  }, [map]);

  // Callback for each ClusteredMarker to register / deregister its element.
  const handleMarkerReady = React.useCallback(
    (id: string, el: NonNullable<AdvancedMarkerRef> | null) => {
      const clusterer = clustererRef.current;
      if (!clusterer) return;

      const prev = markerElsRef.current.get(id);

      if (el === null) {
        // Marker unmounted — remove from clusterer.
        if (prev) {
          clusterer.removeMarker(prev);
          markerElsRef.current.delete(id);
        }
        return;
      }

      if (prev === el) return; // No change.

      // Remove stale entry if element reference changed.
      if (prev) {
        clusterer.removeMarker(prev);
      }

      markerElsRef.current.set(id, el);
      clusterer.addMarker(el);
    },
    [],
  );

  return (
    <>
      {markers.map((marker) => (
        <ClusteredMarker
          key={marker.id}
          marker={marker}
          isActive={activeMarkerId === marker.id}
          onClick={onMarkerActivate}
          onClose={onMarkerDeactivate}
          onMarkerClick={onMarkerClick}
          onMarkerReady={handleMarkerReady}
        />
      ))}
    </>
  );
}

// ─── Main provider ───────────────────────────────────────────────────────────

export function GoogleMapProvider({
  center,
  zoom,
  markers,
  onMarkerClick,
  initialViewSet = false,
}: MapProviderProps) {
  const { t } = useTranslation();
  const [activeMarker, setActiveMarker] = React.useState<MapMarker | null>(null);
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');

  if (!apiKey) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed">
        <div className="text-center">
          <p className="text-muted-foreground">{t('map.google_not_configured')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('map.google_set_key')}</p>
        </div>
      </div>
    );
  }

  return (
    <APIProvider apiKey={apiKey}>
      <Map
        defaultCenter={{ lat: center[0], lng: center[1] }}
        defaultZoom={zoom}
        gestureHandling="greedy"
        mapId="dpg-items-map"
        reuseMaps
        // Native fullscreen only maximizes the map's own element, which would
        // hide our overlay (filters / maximize button). We provide our own
        // maximize control on the wrapper instead — see MapView.
        fullscreenControl={false}
        // Clicking empty map area closes any open marker popup. Marker clicks
        // do not bubble to this handler in the Google Maps API, so opening a
        // popup is not immediately undone.
        onClick={() => setActiveMarker(null)}
        className="h-full w-full rounded-lg"
      >
        {/*
         * MapViewController imperatively pans/zooms the Google map when the
         * user picks a specific own-profile from the selector. Only active
         * when initialViewSet=true so it never fights the user during normal
         * panning or when "All items" / fit-all mode is active.
         */}
        <MapViewController center={center} zoom={zoom} initialViewSet={initialViewSet} />
        <ClustererManager
          markers={markers}
          activeMarkerId={activeMarker?.id ?? null}
          onMarkerActivate={setActiveMarker}
          onMarkerDeactivate={() => setActiveMarker(null)}
          onMarkerClick={onMarkerClick}
        />
      </Map>
    </APIProvider>
  );
}

registerMapProvider({ name: 'google-maps', component: GoogleMapProvider });
