/// <reference types="google.maps" />
import * as React from 'react';
import { createPortal } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import {
  AdvancedMarker,
  APIProvider,
  ColorScheme,
  InfoWindow,
  Map,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import type { AdvancedMarkerRef } from '@vis.gl/react-google-maps';
import { MarkerClusterer, type Renderer, type Cluster } from '@googlemaps/markerclusterer';
import type { MapMarker, MapProviderProps, MapViewport } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { useIsMobile } from '@/hooks/use-mobile';
import { useThemeMode } from '@/theme/mode-provider';
import { getIconForDomain } from '../domain-icons';
import { tallyDomains } from '../cluster-breakdown';
import { MarkerPopupCard } from '../marker-popup-card';
import { SelfMarkerContent, SELF_MARKER_GOOGLE_OFFSET_Y } from '../self-marker';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { useViewportReportEmitter } from './use-viewport-report';

/**
 * AdvancedMarkerElement to domain, filled by each ClusteredMarker and read by
 * the cluster renderer for the per-domain badge row.
 */
const markerDomainMap = new WeakMap<object, string>();

// Stacking: self (0) < item pins (500) < clusters (1000 + count). The
// non-interactive "You" marker sits below item pins so an item on the same
// point (fanned only ~10 m, sub-pixel at low zoom) stays clickable.
const SELF_MARKER_Z_INDEX = 0;
const ITEM_MARKER_Z_INDEX = 500;

// Zoom cap for a cluster click; co-located points zoom straight to it.
const CLUSTER_CLICK_MAX_ZOOM = 20;
// Cluster-click zoom animation duration (ms), tunable per deploy via runtime
// config; default 2000, 0 = instant.
function resolveClusterZoomAnimMs(): number {
  const raw = getRuntimeEnv('VITE_MAP_CLUSTER_ZOOM_ANIM_MS');
  if (raw == null || String(raw).trim() === '') return 2000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}
const CLUSTER_ZOOM_ANIM_MS = resolveClusterZoomAnimMs();
const WORLD_PX = 256;

/**
 * The fractional zoom at which `bounds` fills `dim`, the same target as
 * `fitBounds`. Zero-size bounds (co-located points) yield the max cap.
 */
function getBoundsZoomLevel(
  bounds: google.maps.LatLngBounds,
  dim: { width: number; height: number },
): number {
  const latRad = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return Math.log((1 + s) / (1 - s)) / 2;
  };
  const zoomFor = (px: number, fraction: number) => Math.log(px / WORLD_PX / fraction) / Math.LN2;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const latFraction = (latRad(ne.lat()) - latRad(sw.lat())) / Math.PI;
  const lngDiff = ne.lng() - sw.lng();
  const lngFraction = (lngDiff < 0 ? lngDiff + 360 : lngDiff) / 360;
  const latZoom = latFraction > 0 ? zoomFor(dim.height, latFraction) : CLUSTER_CLICK_MAX_ZOOM;
  const lngZoom = lngFraction > 0 ? zoomFor(dim.width, lngFraction) : CLUSTER_CLICK_MAX_ZOOM;
  return Math.min(latZoom, lngZoom, CLUSTER_CLICK_MAX_ZOOM);
}

/**
 * Animates the camera to `target` over CLUSTER_ZOOM_ANIM_MS with
 * `moveCamera`. The map has a `mapId` (vector map), so fractional zoom renders
 * crisply. `animRef` holds the in-flight frame so a new click or unmount
 * cancels it.
 */
function animateMapCamera(
  map: google.maps.Map,
  target: { lat: number; lng: number; zoom: number },
  animRef: React.MutableRefObject<number | null>,
): void {
  if (animRef.current != null) cancelAnimationFrame(animRef.current);
  const startZoom = map.getZoom() ?? target.zoom;
  const c = map.getCenter();
  const startLat = c ? c.lat() : target.lat;
  const startLng = c ? c.lng() : target.lng;
  const start = performance.now();
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const frame = (now: number) => {
    const p = Math.min((now - start) / CLUSTER_ZOOM_ANIM_MS, 1);
    const e = easeOutCubic(p);
    map.moveCamera({
      center: {
        lat: startLat + (target.lat - startLat) * e,
        lng: startLng + (target.lng - startLng) * e,
      },
      zoom: startZoom + (target.zoom - startZoom) * e,
    });
    animRef.current = p < 1 ? requestAnimationFrame(frame) : null;
  };
  animRef.current = requestAnimationFrame(frame);
}

/**
 * Resolves a CSS custom property to an rgb/hex string for the generated
 * cluster HTML. The theme stores `--primary` as `oklch(...)`; a canvas
 * `fillStyle` round-trip normalizes it.
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
 * Builds the cluster bubble as HTML for AdvancedMarkerElement content: the
 * total in a `--primary` circle and, when several domains are present, a row
 * of per-domain icon+count chips below it.
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
  // Hook for the mobile-only legibility rule in index.css.
  circle.className = 'dpg-cluster-count';
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

/** Cluster renderer using the network theme colour and a per-domain breakdown. */
const clusterRenderer: Renderer = {
  render(cluster: Cluster) {
    const { count, position, markers } = cluster;
    // Neutral gray fallback, not any network's brand colour.
    const primary = resolveThemeColor('--primary', '#6b7280');

    // Only markers with a known domain are tallied; an unregistered one would
    // add a phantom '' group. The total (`cluster.count`) is unaffected.
    const domains = (markers ?? [])
      .map((m) => markerDomainMap.get(m as object))
      .filter((d): d is string => Boolean(d));
    const breakdown = tallyDomains(domains);

    return new google.maps.marker.AdvancedMarkerElement({
      position,
      content: buildClusterContent(count, breakdown, primary),
      zIndex: 1000 + count,
    });
  },
};

// Each ClusteredMarker reports its AdvancedMarkerElement via `onMarkerReady`
// so the parent can register it with the MarkerClusterer.

interface ClusteredMarkerProps {
  marker: MapMarker;
  isActive: boolean;
  onClick: (marker: MapMarker) => void;
  onClose: () => void;
  onMarkerClick?: (id: string) => void;
  onMarkerReady: (id: string, el: NonNullable<AdvancedMarkerRef> | null) => void;
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  resolveIcon?: MapProviderProps['resolveIcon'];
  resolveMarkerImage?: MapProviderProps['resolveMarkerImage'];
}

function ClusteredMarker({
  marker,
  isActive,
  onClick,
  onClose,
  onMarkerClick,
  onMarkerReady,
  renderPopup,
  resolveIcon,
  resolveMarkerImage,
}: ClusteredMarkerProps) {
  const [markerRef, markerEl] = useAdvancedMarkerRef();
  const { id } = marker;
  const map = useMap();
  const isMobile = useIsMobile();

  // Google auto-pans an InfoWindow into view when it opens, not when its
  // content later grows, so a resize observer pans the map to keep the card
  // visible.
  const popupObserverRef = React.useRef<ResizeObserver | null>(null);
  const popupPrevHeightRef = React.useRef<number | null>(null);

  const fitPopupInView = React.useCallback(
    (el: HTMLElement) => {
      if (!map) return;
      const mapDiv = map.getDiv();
      if (!mapDiv) return;
      const mapRect = mapDiv.getBoundingClientRect();
      const cardRect = el.getBoundingClientRect();
      const MARGIN = 16;
      const topOverflow = mapRect.top + MARGIN - cardRect.top;
      const bottomOverflow = cardRect.bottom - (mapRect.bottom - MARGIN);
      // Prefer revealing a clipped top (the header); otherwise a clipped bottom.
      const dy = topOverflow > 0 ? -topOverflow : bottomOverflow > 0 ? bottomOverflow : 0;
      if (Math.abs(dy) > 1) map.panBy(0, dy);
    },
    [map]
  );

  const popupContentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      popupObserverRef.current?.disconnect();
      popupPrevHeightRef.current = null;
      if (!node) return;
      const ro = new ResizeObserver(() => {
        const h = node.getBoundingClientRect().height;
        // Skip the first measurement so this does not fight Google's
        // open-time auto-pan.
        if (
          popupPrevHeightRef.current !== null &&
          Math.abs(h - popupPrevHeightRef.current) > 1
        ) {
          requestAnimationFrame(() => fitPopupInView(node));
        }
        popupPrevHeightRef.current = h;
      });
      ro.observe(node);
      popupObserverRef.current = ro;
    },
    [fitPopupInView]
  );

  React.useEffect(() => () => popupObserverRef.current?.disconnect(), []);

  const DomainIcon = resolveIcon ? resolveIcon(marker) : getIconForDomain(marker.domain);
  const markerImage = resolveMarkerImage?.(marker) ?? null;

  React.useEffect(() => {
    if (markerEl) {
      markerDomainMap.set(markerEl, marker.domain ?? '');
    }
    onMarkerReady(id, markerEl);
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
        // Above the "You" self-marker; see ITEM_MARKER_Z_INDEX.
        zIndex={ITEM_MARKER_Z_INDEX}
        onClick={() => {
          if (isActive) {
            onClose();
          } else {
            onClick(marker);
          }
          onMarkerClick?.(marker.id);
        }}
      >
        {/*
         * A styled div child rather than <Pin glyph>: vis.gl's glyph prop takes
         * a string or DOM element, and a React icon node silently renders
         * nothing.
         */}
        {markerImage ? (
          <div
            className="flex items-center justify-center overflow-hidden rounded-full border-2 border-white bg-white shadow-md"
            style={{ width: 30, height: 30 }}
          >
            <img src={markerImage} alt="" className="h-full w-full object-cover" />
          </div>
        ) : (
          <div
            className="flex items-center justify-center rounded-full border-2 border-white bg-primary text-primary-foreground shadow-md"
            style={{ width: 30, height: 30 }}
          >
            <DomainIcon size={16} strokeWidth={2.5} />
          </div>
        )}
      </AdvancedMarker>
      {isActive &&
        (isMobile
          ? // Mobile: render the card as a centered overlay (portal to <body>)
            // instead of the InfoWindow, which pushed tall cards off-screen and
            // gave them no bounded height to scroll.
            createPortal(
              <div
                className="fixed inset-0 z-[2000] flex items-center justify-center p-3"
                role="dialog"
                aria-modal="true"
              >
                <button
                  type="button"
                  aria-label="Close"
                  className="absolute inset-0 bg-black/40"
                  onClick={onClose}
                />
                <div className="relative">
                  {renderPopup ? (
                    renderPopup(marker)
                  ) : (
                    <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
                  )}
                </div>
              </div>,
              document.body,
            )
          : markerEl && (
              <InfoWindow anchor={markerEl} onCloseClick={onClose} headerDisabled>
                <div ref={popupContentRef}>
                  {renderPopup ? (
                    renderPopup(marker)
                  ) : (
                    <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
                  )}
                </div>
              </InfoWindow>
            ))}
    </>
  );
}

// Pans/zooms the map to `center`/`zoom` when `initialViewSet` is true; when
// false it leaves the map alone so it does not fight user panning.

interface MapViewControllerProps {
  center: [number, number];
  zoom: number;
  initialViewSet: boolean;
  focusNonce?: number;
}

function MapViewController({ center, zoom, initialViewSet, focusNonce }: MapViewControllerProps) {
  const map = useMap();
  const prevCenter = React.useRef<[number, number] | null>(null);
  const prevZoom = React.useRef<number | null>(null);
  const prevNonce = React.useRef<number | undefined>(focusNonce);

  React.useEffect(() => {
    if (!map || !initialViewSet) return;

    const sameCenter =
      prevCenter.current !== null &&
      prevCenter.current[0] === center[0] &&
      prevCenter.current[1] === center[1];
    const sameZoom = prevZoom.current === zoom;
    // An explicit recenter intent (nonce bump) snaps back even if the
    // coordinate is unchanged and the user has since panned away.
    const nonceChanged = prevNonce.current !== focusNonce;

    if (nonceChanged || !sameCenter || !sameZoom) {
      map.panTo({ lat: center[0], lng: center[1] });
      map.setZoom(zoom);
    }

    prevCenter.current = center;
    prevZoom.current = zoom;
    prevNonce.current = focusNonce;
  }, [center, zoom, initialViewSet, focusNonce, map]);

  return null;
}

// Reports the viewport (centre, bounds corners, zoom) on debounced `idle`.
// Mounted only when `onViewportChange` is provided. Also emits once on mount
// for parity with the Leaflet provider; skipped when bounds are not ready,
// since the first `idle` covers it.

function ViewportReporter({ onViewportChange }: { onViewportChange: (viewport: MapViewport) => void }) {
  const map = useMap();
  const { emit, emitNow } = useViewportReportEmitter(onViewportChange);

  React.useEffect(() => {
    if (!map) return;
    const listener = map.addListener('idle', () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      if (!center || !bounds) return;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emit(
        { lat: center.lat(), lng: center.lng() },
        { ne: { lat: ne.lat(), lng: ne.lng() }, sw: { lat: sw.lat(), lng: sw.lng() } },
        map.getZoom(),
      );
    });

    const center = map.getCenter();
    const bounds = map.getBounds();
    if (center && bounds) {
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emitNow(
        { lat: center.lat(), lng: center.lng() },
        { ne: { lat: ne.lat(), lng: ne.lng() }, sw: { lat: sw.lat(), lng: sw.lng() } },
        map.getZoom(),
      );
    }

    return () => listener.remove();
  }, [map, emit, emitNow]);

  return null;
}

// Keeps a MarkerClusterer in sync with the elements ClusteredMarker children
// report.

interface ClustererManagerProps {
  markers: MapMarker[];
  activeMarkerId: string | null;
  onMarkerActivate: (marker: MapMarker) => void;
  onMarkerDeactivate: () => void;
  onMarkerClick?: (id: string) => void;
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  resolveIcon?: MapProviderProps['resolveIcon'];
  resolveMarkerImage?: MapProviderProps['resolveMarkerImage'];
}

function ClustererManager({
  markers,
  activeMarkerId,
  onMarkerActivate,
  onMarkerDeactivate,
  onMarkerClick,
  renderPopup,
  resolveIcon,
  resolveMarkerImage,
}: ClustererManagerProps) {
  const map = useMap();

  const markerElsRef = React.useRef<globalThis.Map<string, NonNullable<AdvancedMarkerRef>>>(new globalThis.Map());

  const clustererRef = React.useRef<MarkerClusterer | null>(null);

  const renderRafRef = React.useRef<number | null>(null);
  const cameraAnimRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!map) return;

    const clusterer = new MarkerClusterer({
      map,
      renderer: clusterRenderer,
      // Animates to the zoom the default `fitBounds(cluster.bounds)` would
      // snap to, so one click reveals the cluster's contents.
      onClusterClick: (_event, cluster, clusterMap) => {
        const div = clusterMap.getDiv();
        const dim = { width: div?.offsetWidth || 800, height: div?.offsetHeight || 600 };
        const current = clusterMap.getZoom() ?? 12;
        const fit = cluster.bounds ? getBoundsZoomLevel(cluster.bounds, dim) : current + 3;
        // Zoom in at least one level, never past the cap.
        const targetZoom = Math.min(Math.max(fit, current + 1), CLUSTER_CLICK_MAX_ZOOM);
        const pos = cluster.position;
        animateMapCamera(
          clusterMap,
          { lat: pos.lat(), lng: pos.lng(), zoom: targetZoom },
          cameraAnimRef,
        );
      },
    });
    clustererRef.current = clusterer;

    return () => {
      // Cancel pending frames so nothing fires against a torn-down map.
      if (renderRafRef.current != null) {
        cancelAnimationFrame(renderRafRef.current);
        renderRafRef.current = null;
      }
      if (cameraAnimRef.current != null) {
        cancelAnimationFrame(cameraAnimRef.current);
        cameraAnimRef.current = null;
      }
      // clearMarkers() then setMap(null) is the teardown; calling the internal
      // onRemove() directly can throw. setMap() exists at runtime (inherited
      // via OverlayViewSafe) but is missing from the type declaration.
      clusterer.clearMarkers();
      (clusterer as unknown as { setMap: (map: null) => void }).setMap(null);
      clustererRef.current = null;
    };
  }, [map]);

  // One clusterer render per frame. addMarker/removeMarker redraw the whole
  // set by default, which is O(n^2) as markers register one by one, so they
  // run with noDraw=true and this batches a single render().
  const scheduleRender = React.useCallback(() => {
    if (renderRafRef.current != null) return; // already scheduled this frame
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = null;
      clustererRef.current?.render();
    });
  }, []);

  const handleMarkerReady = React.useCallback(
    (id: string, el: NonNullable<AdvancedMarkerRef> | null) => {
      const clusterer = clustererRef.current;
      if (!clusterer) return;

      const prev = markerElsRef.current.get(id);

      if (el === null) {
        if (prev) {
          clusterer.removeMarker(prev, true);
          markerElsRef.current.delete(id);
          scheduleRender();
        }
        return;
      }

      if (prev === el) return; // No change.

      if (prev) {
        clusterer.removeMarker(prev, true);
      }

      markerElsRef.current.set(id, el);
      clusterer.addMarker(el, true);
      scheduleRender();
    },
    [scheduleRender],
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
          renderPopup={renderPopup}
          resolveIcon={resolveIcon}
          resolveMarkerImage={resolveMarkerImage}
        />
      ))}
    </>
  );
}

// Records the live camera on every 'idle'. A light/dark switch remounts <Map>
// (`colorScheme` is construction-time), and the remount restores this view.
function CameraTracker({
  cameraRef,
}: {
  cameraRef: React.RefObject<{ center: { lat: number; lng: number }; zoom: number } | null>;
}) {
  const map = useMap();
  React.useEffect(() => {
    if (!map) return;
    const update = () => {
      const c = map.getCenter();
      const z = map.getZoom();
      if (c && z != null) cameraRef.current = { center: { lat: c.lat(), lng: c.lng() }, zoom: z };
    };
    const listener = map.addListener('idle', update);
    return () => listener.remove();
  }, [map, cameraRef]);
  return null;
}

export function GoogleMapProvider({
  center,
  zoom,
  markers,
  onMarkerClick,
  initialViewSet = false,
  focusNonce,
  closePopupNonce,
  selfLocation,
  renderPopup,
  showPopup = true,
  resolveIcon,
  resolveMarkerImage,
  onViewportChange,
}: MapProviderProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { resolved: themeMode } = useThemeMode();
  const [activeMarker, setActiveMarker] = React.useState<MapMarker | null>(null);
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');
  const liveCameraRef = React.useRef<{ center: { lat: number; lng: number }; zoom: number } | null>(null);

  // Closes the open popup (mobile overlay or InfoWindow) when
  // `closePopupNonce` changes; the ref guard skips mount and unchanged nonces.
  const prevClosePopupNonce = React.useRef<number | undefined>(closePopupNonce);
  React.useEffect(() => {
    if (prevClosePopupNonce.current !== closePopupNonce) {
      setActiveMarker(null);
    }
    prevClosePopupNonce.current = closePopupNonce;
  }, [closePopupNonce]);

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
        // colorScheme is construction-time, so a theme switch remounts via
        // this key (reuseMaps' cache key includes colorScheme). CameraTracker
        // preserves the view across the remount.
        key={`gmap-${themeMode}`}
        colorScheme={themeMode === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT}
        defaultCenter={liveCameraRef.current?.center ?? { lat: center[0], lng: center[1] }}
        defaultZoom={liveCameraRef.current?.zoom ?? zoom}
        gestureHandling="greedy"
        mapId="dpg-items-map"
        reuseMaps
        // Mobile: Map/Satellite as a dropdown (DROPDOWN_MENU = 2), not the wide
        // bar.
        mapTypeControlOptions={
          isMobile
            ? { style: 2 as google.maps.MapTypeControlStyle }
            : undefined
        }
        // Native fullscreen would hide our overlay controls; MapView provides
        // its own maximize.
        fullscreenControl={false}
        // Clicking empty map area closes any open marker popup. Marker clicks
        // do not bubble to this handler in the Google Maps API, so opening a
        // popup is not immediately undone.
        onClick={() => setActiveMarker(null)}
        className="h-full w-full rounded-lg"
      >
        {/* Drives the camera only when initialViewSet is true. */}
        <MapViewController center={center} zoom={zoom} initialViewSet={initialViewSet} focusNonce={focusNonce} />
        {onViewportChange && <ViewportReporter onViewportChange={onViewportChange} />}
        <CameraTracker cameraRef={liveCameraRef} />
        <ClustererManager
          markers={markers}
          activeMarkerId={activeMarker?.id ?? null}
          // With `showPopup` off no marker ever becomes active, so neither the
          // InfoWindow nor the mobile overlay opens; clicks still reach
          // `onMarkerClick`.
          onMarkerActivate={showPopup ? setActiveMarker : () => {}}
          onMarkerDeactivate={() => setActiveMarker(null)}
          onMarkerClick={onMarkerClick}
          renderPopup={renderPopup}
          resolveIcon={resolveIcon}
          resolveMarkerImage={resolveMarkerImage}
        />
        {/*
         * "You are here": outside the clusterer so it is never clustered, and
         * non-clickable. The content is shifted by SELF_MARKER_GOOGLE_OFFSET_Y
         * so AdvancedMarker's bottom-centre anchor lands on the dot's centre.
         */}
        {selfLocation && (
          <AdvancedMarker
            position={{ lat: selfLocation.lat, lng: selfLocation.lng }}
            clickable={false}
            // Explicit, since the wrapper's pointer-events when non-clickable
            // is a library default we do not rely on.
            style={{ pointerEvents: 'none' }}
            zIndex={SELF_MARKER_Z_INDEX}
            title={t('map.you_are_here_short')}
          >
            <div style={{ transform: `translateY(${SELF_MARKER_GOOGLE_OFFSET_Y}px)`, pointerEvents: 'none' }}>
              <SelfMarkerContent label={t('map.you_are_here_short')} />
            </div>
          </AdvancedMarker>
        )}
      </Map>
    </APIProvider>
  );
}

registerMapProvider({ name: 'google-maps', component: GoogleMapProvider });
