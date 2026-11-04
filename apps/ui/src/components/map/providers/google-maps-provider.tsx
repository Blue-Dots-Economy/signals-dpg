/// <reference types="google.maps" />
import * as React from 'react';
import { createPortal } from 'react-dom';
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
import type { MapMarker, MapProviderProps, MapViewport, OpenSpotGroup } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { useIsMobile } from '@/hooks/use-mobile';
import { useThemeMode } from '@/theme/mode-provider';
import { getIconForDomain } from '../domain-icons';
import type { DomainCount } from '../cluster-breakdown';
import { useMapClusters } from '../use-map-clusters';
import { openSpotGroupOf } from '../map-clusters';
import type { ClusterView, MapClusterItem } from '../map-clusters';
import { useStableCallback } from '../use-stable-callback';
import { PopupBody, PopupRendererProvider, SpotGroupBody, SpotGroupRendererProvider } from '../popup-renderer';
import { SelfMarkerContent, SELF_MARKER_GOOGLE_OFFSET_Y } from '../self-marker';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { useViewportReportEmitter } from './use-viewport-report';

// Stacking: self (0) < item pins (500) < clusters (1000 + count) < popup, so a pin on the viewer's own spot stays clickable.
const SELF_MARKER_Z_INDEX = 0;
const ITEM_MARKER_Z_INDEX = 500;
// Popup zIndex. Runtime-env so it can be raised per deploy (config.js) without
// a rebuild; default 1,000,000, which a cluster only reaches near a million
// pins. Read at render, not module load, so a late config.js still applies.
const DEFAULT_POPUP_Z_INDEX = 1_000_000;
function resolvePopupZIndex(): number {
  const n = Number(getRuntimeEnv('VITE_MAP_POPUP_Z_INDEX'));
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_POPUP_Z_INDEX;
}

// Zoom cap for a cluster click.
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

function bubbleSize(count: number): number {
  if (count < 10) return 38;
  if (count < 100) return 44;
  return 50;
}

/** The cluster bubble: the total in a `--primary` circle and, for several domains, a row of per-domain chips. */
function ClusterBubble({
  count,
  breakdown,
  primary,
}: Readonly<{
  count: number;
  breakdown: DomainCount[];
  primary: string;
}>) {
  const size = bubbleSize(count);
  return (
    // AdvancedMarker anchors content bottom-centre; shift down so the bubble is centred on the point.
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'translateY(50%)' }}>
      <div
        className="dpg-cluster-count"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: `${size}px`,
          height: `${size}px`,
          background: primary,
          color: '#ffffff',
          border: '2px solid #ffffff',
          borderRadius: 9999,
          boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
          font: '600 14px ui-sans-serif,system-ui,sans-serif',
        }}
      >
        {count}
      </div>
      {breakdown.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginTop: -8 }}>
          {breakdown.map((b) => {
            const Icon = getIconForDomain(b.domain);
            return (
              <span
                key={b.domain}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 9999,
                  padding: '2px 7px 2px 5px',
                  font: '600 11px ui-sans-serif,system-ui,sans-serif',
                  color: '#1e293b',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                  lineHeight: 1,
                }}
              >
                <Icon size={11} color={primary} strokeWidth={2.4} />
                <span>{b.count}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

const ClusterMarker = React.memo(function ClusterMarker({
  item,
  primary,
  onZoomTo,
  onSpotClick,
  isSpotOpen,
  onSpotClose,
}: {
  item: Extract<MapClusterItem, { kind: 'cluster' }>;
  primary: string;
  onZoomTo: (lat: number, lng: number, expansionZoom: number) => void;
  onSpotClick: (group: OpenSpotGroup) => void;
  isSpotOpen: boolean;
  onSpotClose: () => void;
}) {
  const [markerRef, markerEl] = useAdvancedMarkerRef();
  const position = React.useMemo(() => ({ lat: item.lat, lng: item.lng }), [item.lat, item.lng]);
  const group = React.useMemo(() => openSpotGroupOf(item), [item]);
  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={position}
        title={String(item.count)}
        zIndex={1000 + item.count}
        onClick={() => (group ? onSpotClick(group) : onZoomTo(item.lat, item.lng, item.expansionZoom))}
      >
        <ClusterBubble count={item.count} breakdown={item.breakdown} primary={primary} />
      </AdvancedMarker>
      {group && isSpotOpen && markerEl && (
        <InfoWindow anchor={markerEl} onCloseClick={onSpotClose} headerDisabled zIndex={resolvePopupZIndex()}>
          <SpotGroupBody group={group} onClose={onSpotClose} />
        </InfoWindow>
      )}
    </>
  );
});


interface PointMarkerProps {
  marker: MapMarker;
  isActive: boolean;
  onClick: (marker: MapMarker) => void;
  onClose: () => void;
  onMarkerClick?: (id: string) => void;
  resolveIcon?: MapProviderProps['resolveIcon'];
  resolveMarkerImage?: MapProviderProps['resolveMarkerImage'];
}

const PointMarker = React.memo(function PointMarker({
  marker,
  isActive,
  onClick,
  onClose,
  onMarkerClick,
  resolveIcon,
  resolveMarkerImage,
}: PointMarkerProps) {
  const [markerRef, markerEl] = useAdvancedMarkerRef();
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

  const position = React.useMemo(() => ({ lat: marker.lat, lng: marker.lng }), [marker.lat, marker.lng]);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={position}
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
                  <PopupBody marker={marker} onViewDetails={onMarkerClick} />
                </div>
              </div>,
              document.body,
            )
          : markerEl && (
              <InfoWindow anchor={markerEl} onCloseClick={onClose} headerDisabled zIndex={resolvePopupZIndex()}>
                <div ref={popupContentRef}>
                  <PopupBody marker={marker} onViewDetails={onMarkerClick} />
                </div>
              </InfoWindow>
            ))}
    </>
  );
});

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

/** The map's current bounds and zoom, updated on every `idle`; null until the map has bounds. */
function useGoogleClusterView(map: google.maps.Map | null): ClusterView | null {
  const [view, setView] = React.useState<ClusterView | null>(null);
  React.useEffect(() => {
    if (!map) return;
    const read = () => {
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      if (!bounds || zoom == null) return;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      const wraps = sw.lng() > ne.lng();
      setView({
        west: wraps ? -180 : sw.lng(),
        south: sw.lat(),
        east: wraps ? 180 : ne.lng(),
        north: ne.lat(),
        zoom,
      });
    };
    read();
    const listener = map.addListener('idle', read);
    return () => listener.remove();
  }, [map]);
  return view;
}

interface ClusterLayerProps {
  markers: MapMarker[];
  openSpotKey: string | null;
  onSpotClick: (group: OpenSpotGroup) => void;
  onSpotClose: () => void;
  activeMarkerId: string | null;
  onMarkerActivate: (marker: MapMarker) => void;
  onMarkerDeactivate: () => void;
  onMarkerClick?: (id: string) => void;
  resolveIcon?: MapProviderProps['resolveIcon'];
  resolveMarkerImage?: MapProviderProps['resolveMarkerImage'];
}

/** Draws only the bubbles and pins in view, as computed by the shared clustering module. */
function ClusterLayer({
  markers,
  openSpotKey,
  onSpotClick,
  onSpotClose,
  activeMarkerId,
  onMarkerActivate,
  onMarkerDeactivate,
  onMarkerClick,
  resolveIcon,
  resolveMarkerImage,
}: Readonly<ClusterLayerProps>) {
  const map = useMap();
  const view = useGoogleClusterView(map);
  const items = useMapClusters(markers, view, { maxZoom: CLUSTER_CLICK_MAX_ZOOM });
  const { resolved: themeMode } = useThemeMode();
  // Neutral gray fallback, not any network's brand colour.
  const primary = React.useMemo(() => resolveThemeColor('--primary', '#6b7280'), [themeMode]);
  const cameraAnimRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (activeMarkerId && !items.some((item) => item.kind === 'point' && item.marker.id === activeMarkerId)) {
      onMarkerDeactivate();
    }
  }, [items, activeMarkerId, onMarkerDeactivate]);

  React.useEffect(() => {
    if (openSpotKey && !items.some((item) => item.key === openSpotKey)) onSpotClose();
  }, [items, openSpotKey, onSpotClose]);

  React.useEffect(
    () => () => {
      if (cameraAnimRef.current != null) cancelAnimationFrame(cameraAnimRef.current);
    },
    [],
  );

  const zoomTo = React.useCallback(
    (lat: number, lng: number, expansionZoom: number) => {
      if (!map) return;
      const current = map.getZoom() ?? 12;
      const zoom =
        current >= CLUSTER_CLICK_MAX_ZOOM
          ? current
          : Math.min(Math.max(expansionZoom, current + 1), CLUSTER_CLICK_MAX_ZOOM);
      animateMapCamera(map, { lat, lng, zoom }, cameraAnimRef);
    },
    [map],
  );

  return (
    <>
      {items.map((item) =>
        item.kind === 'cluster' ? (
          <ClusterMarker
            key={item.key}
            item={item}
            primary={primary}
            onZoomTo={zoomTo}
            onSpotClick={onSpotClick}
            isSpotOpen={openSpotKey === item.key}
            onSpotClose={onSpotClose}
          />
        ) : (
          <PointMarker
            key={item.key}
            marker={item.marker}
            isActive={activeMarkerId === item.marker.id}
            onClick={onMarkerActivate}
            onClose={onMarkerDeactivate}
            onMarkerClick={onMarkerClick}
            resolveIcon={resolveIcon}
            resolveMarkerImage={resolveMarkerImage}
          />
        ),
      )}
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

const noActivation = (_marker: MapMarker) => {};

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
  renderSpotGroup,
  onSpotGroupSelect,
}: MapProviderProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { resolved: themeMode } = useThemeMode();
  const [activeMarker, setActiveMarker] = React.useState<MapMarker | null>(null);
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');
  const liveCameraRef = React.useRef<{ center: { lat: number; lng: number }; zoom: number } | null>(null);
  const [openSpotKey, setOpenSpotKey] = React.useState<string | null>(null);
  const activateMarker = React.useCallback((marker: MapMarker) => {
    setOpenSpotKey(null);
    setActiveMarker(marker);
  }, []);
  const deactivateMarker = React.useCallback(() => setActiveMarker(null), []);
  const closeSpot = React.useCallback(() => setOpenSpotKey(null), []);
  const stableSpotGroupSelect = useStableCallback(onSpotGroupSelect);
  const spotClick = React.useCallback(
    (group: OpenSpotGroup) => {
      if (!showPopup) {
        stableSpotGroupSelect?.(group);
        return;
      }
      setActiveMarker(null);
      setOpenSpotKey(group.key);
    },
    [showPopup, stableSpotGroupSelect],
  );
  const stableMarkerClick = useStableCallback(onMarkerClick);
  const stableResolveIcon = useStableCallback(resolveIcon);
  const stableResolveMarkerImage = useStableCallback(resolveMarkerImage);

  // Closes the open popup (mobile overlay or InfoWindow) when
  // `closePopupNonce` changes; the ref guard skips mount and unchanged nonces.
  const prevClosePopupNonce = React.useRef<number | undefined>(closePopupNonce);
  React.useEffect(() => {
    if (prevClosePopupNonce.current !== closePopupNonce) {
      setActiveMarker(null);
      setOpenSpotKey(null);
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
        onClick={() => {
          setActiveMarker(null);
          setOpenSpotKey(null);
        }}
        className="h-full w-full rounded-lg"
      >
        {/* Drives the camera only when initialViewSet is true. */}
        <MapViewController center={center} zoom={zoom} initialViewSet={initialViewSet} focusNonce={focusNonce} />
        {onViewportChange && <ViewportReporter onViewportChange={onViewportChange} />}
        <CameraTracker cameraRef={liveCameraRef} />
        <PopupRendererProvider value={renderPopup}>
          <SpotGroupRendererProvider value={renderSpotGroup}>
            <ClusterLayer
              markers={markers}
              openSpotKey={openSpotKey}
              onSpotClick={spotClick}
              onSpotClose={closeSpot}
              activeMarkerId={activeMarker?.id ?? null}
              // With `showPopup` off no marker ever becomes active, so neither the
              // InfoWindow nor the mobile overlay opens; clicks still reach
              // `onMarkerClick`.
              onMarkerActivate={showPopup ? activateMarker : noActivation}
              onMarkerDeactivate={deactivateMarker}
              onMarkerClick={stableMarkerClick}
              resolveIcon={stableResolveIcon}
              resolveMarkerImage={stableResolveMarkerImage}
            />
          </SpotGroupRendererProvider>
        </PopupRendererProvider>
        {/*
         * "You are here": outside clustering so it is never clustered, and
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
