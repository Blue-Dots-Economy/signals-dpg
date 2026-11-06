import * as React from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import type { LucideIcon } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MapMarker, MapProviderProps, MapViewport, OpenSpotGroup } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { useThemeMode } from '@/theme/mode-provider';
import { getIconForDomain } from '../domain-icons';
import type { DomainCount } from '../cluster-breakdown';
import { FitBounds } from '../fit-bounds';
import { useMapClusters } from '../use-map-clusters';
import { openSpotGroupOf } from '../map-clusters';
import type { ClusterView, MapClusterItem } from '../map-clusters';
import { useStableCallback } from '../use-stable-callback';
import { PopupBody, PopupRendererProvider, SpotGroupBody, SpotGroupRendererProvider } from '../popup-renderer';
import { createSelfMarkerDivIcon } from '../self-marker';
import { useViewportReportEmitter } from './use-viewport-report';

import 'leaflet/dist/leaflet.css';

const MAX_ZOOM = 18;
// Stacking mirrors Google: self < item pins < bubbles (1000 + count), so a pin on the viewer's own spot stays visible.
const SELF_Z_INDEX_OFFSET = 0;
const ITEM_Z_INDEX_OFFSET = 500;
const HOVERED_CLUSTER_Z_INDEX_OFFSET = 10_000_000;

/**
 * Session-scoped flag so the "dark mode is off for the map" notice shows once,
 * not on every remount (route change, maximize). `sessionStorage` so a new tab
 * shows it again.
 */
const DARK_BASEMAP_NOTICE_KEY = 'dpg-map-dark-basemap-notice';

function claimDarkBasemapNotice(): boolean {
  try {
    if (sessionStorage.getItem(DARK_BASEMAP_NOTICE_KEY)) return false;
    sessionStorage.setItem(DARK_BASEMAP_NOTICE_KEY, '1');
    return true;
  } catch {
    // sessionStorage may be disabled (private mode). Show the notice rather
    // than swallow it; the stable toast `id` still prevents a visible stack.
    return true;
  }
}

/** Pans/zooms the map when `center`, `zoom` or `focusNonce` changes. */
function SetView({
  center,
  zoom,
  focusNonce,
}: {
  center: [number, number];
  zoom: number;
  focusNonce?: number;
}) {
  const map = useMap();
  const prevCenter = React.useRef<[number, number] | null>(null);
  const prevZoom = React.useRef<number | null>(null);
  const prevNonce = React.useRef<number | undefined>(focusNonce);

  React.useEffect(() => {
    const sameCenter =
      prevCenter.current !== null &&
      prevCenter.current[0] === center[0] &&
      prevCenter.current[1] === center[1];
    const sameZoom = prevZoom.current === zoom;
    // An explicit recenter intent (nonce bump) snaps back even if the
    // coordinate is unchanged and the user has since panned away.
    const nonceChanged = prevNonce.current !== focusNonce;

    if (nonceChanged || !sameCenter || !sameZoom) {
      map.setView(center, zoom);
    }

    prevCenter.current = center;
    prevZoom.current = zoom;
    prevNonce.current = focusNonce;
  }, [center, zoom, focusNonce, map]);

  return null;
}

/**
 * Closes the open popup when `closePopupNonce` changes. Leaflet tracks the
 * open popup internally, so `map.closePopup()` is the escape hatch. The ref
 * guard prevents a close on mount or an unchanged nonce.
 */
function ClosePopupOnNonce({ closePopupNonce }: { closePopupNonce?: number }) {
  const map = useMap();
  const prevNonce = React.useRef<number | undefined>(closePopupNonce);

  React.useEffect(() => {
    if (prevNonce.current !== closePopupNonce) {
      map.closePopup();
    }
    prevNonce.current = closePopupNonce;
  }, [closePopupNonce, map]);

  return null;
}

/**
 * Reports the viewport (centre, bounds corners, zoom) on debounced `moveend`.
 * Mounted only when `onViewportChange` is provided.
 *
 * Also emits the current viewport once on mount, bypassing the debounce:
 * Leaflet's initial `moveend` fires before this listener attaches, so a
 * viewer with no location would otherwise never get markers. Skipped when the
 * bounds are not valid yet; a later `moveend` covers that case.
 */
function ViewportReporter({ onViewportChange }: { onViewportChange: (viewport: MapViewport) => void }) {
  const map = useMap();
  const { emit, emitNow } = useViewportReportEmitter(onViewportChange);

  React.useEffect(() => {
    const handleMoveEnd = () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emit(
        { lat: center.lat, lng: center.lng },
        { ne: { lat: ne.lat, lng: ne.lng }, sw: { lat: sw.lat, lng: sw.lng } },
        map.getZoom(),
      );
    };
    map.on('moveend', handleMoveEnd);

    const bounds = map.getBounds();
    if (bounds.isValid()) {
      const center = map.getCenter();
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emitNow(
        { lat: center.lat, lng: center.lng },
        { ne: { lat: ne.lat, lng: ne.lng }, sw: { lat: sw.lat, lng: sw.lng } },
        map.getZoom(),
      );
    }

    return () => {
      map.off('moveend', handleMoveEnd);
    };
  }, [map, emit, emitNow]);

  return null;
}

/** The theme's marker fill and its foreground colour. */
interface ThemeColours {
  bg: string;
  fg: string;
}

function readThemeColours(): ThemeColours {
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
  return { bg: read('--primary', '#6b7280'), fg: read('--primary-foreground', '#ffffff') };
}

/**
 * Builds a 32 px teardrop divIcon in the theme `--primary` colour with the
 * marker's lucide icon in `--primary-foreground`.
 */
function createMarkerDivIcon(IconComponent: LucideIcon, bg: string, iconColor: string): L.DivIcon {
  const svgString = renderToStaticMarkup(
    React.createElement(IconComponent, {
      size: 16,
      color: iconColor,
      strokeWidth: 2,
    })
  );

  // A square with one square corner, rotated -45deg, makes the teardrop.
  const html = `
    <div style="
      position: relative;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${bg};
      border: 2px solid #ffffff;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    ">
      <div style="transform: rotate(45deg); line-height: 0;">
        ${svgString}
      </div>
    </div>
  `.trim();

  return L.divIcon({
    html,
    // Anchored at the teardrop's tip.
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -34],
    className: '', // Clear Leaflet's default white-box class
  });
}

const markerIconCache = new WeakMap<LucideIcon, Map<string, L.DivIcon>>();

/** One teardrop icon per glyph and theme colour pair, shared by every pin that uses it. */
function getMarkerDivIcon(IconComponent: LucideIcon, { bg, fg }: ThemeColours): L.DivIcon {
  const colourKey = `${bg}|${fg}`;
  let byColour = markerIconCache.get(IconComponent);
  if (!byColour) {
    byColour = new Map();
    markerIconCache.set(IconComponent, byColour);
  }
  let icon = byColour.get(colourKey);
  if (!icon) {
    icon = createMarkerDivIcon(IconComponent, bg, fg);
    byColour.set(colourKey, icon);
  }
  return icon;
}

/**
 * Builds the cluster bubble in the network theme colours. When the cluster
 * spans several domains, a row of per-domain icon+count chips (largest first)
 * renders below the circle.
 */
export function createClusterDivIcon(count: number, breakdown: DomainCount[], { bg, fg }: ThemeColours): L.DivIcon {
  const size = count < 10 ? 34 : count < 100 ? 40 : 46;

  const multiDomain = breakdown.length > 1;

  let badgesHtml = '';
  if (multiDomain) {
    const chips = breakdown.map(({ domain, count: dc }) => {
      const Icon = getIconForDomain(domain);
      const iconSvg = renderToStaticMarkup(
        React.createElement(Icon, { size: 12, color: bg, strokeWidth: 2 }),
      );
      return `
        <span style="
          display: inline-flex;
          align-items: center;
          gap: 3px;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 9999px;
          padding: 1px 5px;
          font-size: 10px;
          font-weight: 600;
          color: #1e293b;
          line-height: 1;
          white-space: nowrap;
        ">
          ${iconSvg}
          ${dc}
        </span>`;
    });

    badgesHtml = `
      <div style="
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 3px;
        margin-top: 4px;
        flex-wrap: nowrap;
      ">
        ${chips.join('')}
      </div>`;
  }

  const html = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      /* no width constraint — let badge row set the width */
    ">
      <div class="dpg-cluster-count" style="
        display: flex;
        align-items: center;
        justify-content: center;
        width: ${size}px;
        height: ${size}px;
        background: ${bg};
        color: ${fg};
        border: 2px solid #ffffff;
        border-radius: 9999px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        font-size: 13px;
        font-weight: 600;
        flex-shrink: 0;
      ">${count}</div>
      ${badgesHtml}
    </div>
  `.trim();

  // Size the icon to include the badge row, since Leaflet clips overflow.
  const badgeRowH = multiDomain ? 22 : 0; // 18px chip + 4px margin
  const totalH = size + badgeRowH;
  // ~35px per chip plus 3px gaps.
  const estimatedBadgeW = multiDomain ? breakdown.length * 38 + (breakdown.length - 1) * 3 : size;
  const totalW = Math.max(size, estimatedBadgeW);

  return L.divIcon({
    html,
    className: '',
    // Anchor on the main circle, not the badge row.
    iconSize: L.point(totalW, totalH),
    iconAnchor: L.point(totalW / 2, size / 2),
  });
}

function readClusterView(map: L.Map): ClusterView | null {
  const bounds = map.getBounds();
  if (!bounds.isValid()) return null;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const wraps = sw.lng > ne.lng;
  return {
    west: wraps ? -180 : sw.lng,
    south: sw.lat,
    east: wraps ? 180 : ne.lng,
    north: ne.lat,
    zoom: map.getZoom(),
  };
}

function sameView(a: ClusterView | null, b: ClusterView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.west === b.west && a.south === b.south && a.east === b.east && a.north === b.north && a.zoom === b.zoom;
}

/** The map's current bounds and zoom, updated on `moveend` and `zoomend`; null until the map has valid bounds. */
function useLeafletClusterView(): ClusterView | null {
  const map = useMap();
  const [view, setView] = React.useState<ClusterView | null>(null);
  const refresh = React.useCallback(() => {
    const next = readClusterView(map);
    setView((prev) => (sameView(prev, next) ? prev : next));
  }, [map]);
  const handlers = React.useMemo(() => ({ moveend: refresh, zoomend: refresh }), [refresh]);
  useMapEvents(handlers);
  React.useEffect(refresh, [refresh]);
  return view;
}

const ClusterMarker = React.memo(function ClusterMarker({
  item,
  colours,
  showPopup,
  onZoomTo,
  onSpotGroupSelect,
}: {
  item: Extract<MapClusterItem, { kind: 'cluster' }>;
  colours: ThemeColours;
  showPopup: boolean;
  onZoomTo: (lat: number, lng: number, expansionZoom: number) => void;
  onSpotGroupSelect?: (group: OpenSpotGroup) => void;
}) {
  const map = useMap();
  const icon = React.useMemo(
    () => createClusterDivIcon(item.count, item.breakdown, colours),
    [item.count, item.breakdown, colours],
  );
  const group = React.useMemo(() => openSpotGroupOf(item), [item]);
  const [hovered, setHovered] = React.useState(false);
  const eventHandlers = React.useMemo(
    () => ({
      click: () => {
        if (!group) onZoomTo(item.lat, item.lng, item.expansionZoom);
        else if (!showPopup) onSpotGroupSelect?.(group);
      },
      mouseover: () => setHovered(true),
      mouseout: () => setHovered(false),
    }),
    [group, showPopup, onSpotGroupSelect, onZoomTo, item.lat, item.lng, item.expansionZoom],
  );
  const close = React.useCallback(() => map.closePopup(), [map]);
  return (
    <Marker
      position={[item.lat, item.lng]}
      icon={icon}
      eventHandlers={eventHandlers}
      zIndexOffset={hovered ? HOVERED_CLUSTER_Z_INDEX_OFFSET : 1000 + item.count}
    >
      {group && showPopup && (
        <Popup closeButton={false} className="dpg-marker-popup" minWidth={300} maxWidth={360}>
          <SpotGroupBody group={group} onClose={close} />
        </Popup>
      )}
    </Marker>
  );
});

interface PointMarkerProps {
  marker: MapMarker;
  colours: ThemeColours;
  showPopup: boolean;
  onMarkerClick?: (id: string) => void;
  resolveIcon?: NonNullable<MapProviderProps['resolveIcon']>;
}

const PointMarker = React.memo(function PointMarker({
  marker,
  colours,
  showPopup,
  onMarkerClick,
  resolveIcon,
}: PointMarkerProps) {
  const icon = getMarkerDivIcon(resolveIcon ? resolveIcon(marker) : getIconForDomain(marker.domain), colours);
  const eventHandlers = React.useMemo(() => ({ click: () => onMarkerClick?.(marker.id) }), [onMarkerClick, marker.id]);
  return (
    <Marker position={[marker.lat, marker.lng]} icon={icon} eventHandlers={eventHandlers} zIndexOffset={ITEM_Z_INDEX_OFFSET}>
      {showPopup && (
        <Popup closeButton={false} className="dpg-marker-popup" minWidth={300} maxWidth={300}>
          <PopupBody marker={marker} onViewDetails={onMarkerClick} />
        </Popup>
      )}
    </Marker>
  );
});

interface ClusterLayerProps {
  markers: MapMarker[];
  showPopup: boolean;
  onMarkerClick?: (id: string) => void;
  resolveIcon?: NonNullable<MapProviderProps['resolveIcon']>;
  onSpotGroupSelect?: NonNullable<MapProviderProps['onSpotGroupSelect']>;
}

/** Draws only the bubbles and pins in view, as computed by the shared clustering module. */
function ClusterLayer({
  markers,
  showPopup,
  onMarkerClick,
  resolveIcon,
  onSpotGroupSelect,
}: Readonly<ClusterLayerProps>) {
  const map = useMap();
  const view = useLeafletClusterView();
  const items = useMapClusters(markers, view, { maxZoom: MAX_ZOOM });
  const { resolved: themeMode } = useThemeMode();
  const colours = React.useMemo(() => readThemeColours(), [themeMode]);

  const zoomTo = React.useCallback(
    (lat: number, lng: number, expansionZoom: number) => {
      const zoom = Math.min(Math.max(expansionZoom, map.getZoom() + 1), MAX_ZOOM);
      map.setView([lat, lng], zoom);
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
            colours={colours}
            showPopup={showPopup}
            onZoomTo={zoomTo}
            onSpotGroupSelect={onSpotGroupSelect}
          />
        ) : (
          <PointMarker
            key={item.key}
            marker={item.marker}
            colours={colours}
            showPopup={showPopup}
            onMarkerClick={onMarkerClick}
            resolveIcon={resolveIcon}
          />
        ),
      )}
    </>
  );
}

export function LeafletMapProvider({
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
  onViewportChange,
  renderSpotGroup,
  onSpotGroupSelect,
}: MapProviderProps) {
  const { t } = useTranslation();
  const { resolved: themeMode } = useThemeMode();
  const isDark = themeMode === 'dark';
  const stableMarkerClick = useStableCallback(onMarkerClick);
  const stableResolveIcon = useStableCallback(resolveIcon);
  const stableSpotGroupSelect = useStableCallback(onSpotGroupSelect);

  // Leaflet has no dark basemap (see the TileLayer note), so tell the user
  // once per session. The Google provider has a dark style and no notice.
  React.useEffect(() => {
    if (!isDark) return;
    if (!claimDarkBasemapNotice()) return;
    toast.info(t('map.dark_basemap_notice'), {
      // Stable id so two mounting maps update one toast instead of stacking.
      id: 'map-dark-basemap',
      duration: 6000,
    });
  }, [isDark, t]);

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className="h-full w-full rounded-lg"
      scrollWheelZoom
    >
      {/*
       * Light OSM in every theme. CARTO `dark_all` is API-key-gated and serves
       * a watermarked tile with HTTP 200 when keyless, so it fails silently.
       */}
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {/*
       * No auto-fit when the viewport drives the query: fitBounds fires
       * moveend, which refetches, which refits, in a loop.
       */}
      <FitBounds markers={markers} skip={initialViewSet || Boolean(onViewportChange)} />
      {initialViewSet && <SetView center={center} zoom={zoom} focusNonce={focusNonce} />}
      {onViewportChange && <ViewportReporter onViewportChange={onViewportChange} />}
      <ClosePopupOnNonce closePopupNonce={closePopupNonce} />
      <PopupRendererProvider value={renderPopup}>
        <SpotGroupRendererProvider value={renderSpotGroup}>
          <ClusterLayer
            markers={markers}
            showPopup={showPopup}
            onMarkerClick={stableMarkerClick}
            resolveIcon={stableResolveIcon}
            onSpotGroupSelect={stableSpotGroupSelect}
          />
        </SpotGroupRendererProvider>
      </PopupRendererProvider>
      {/*
       * "You are here": outside the cluster layer so it is never clustered,
       * non-interactive so it never intercepts clicks on pins beneath it.
       */}
      {selfLocation && (
        <Marker
          position={[selfLocation.lat, selfLocation.lng]}
          icon={createSelfMarkerDivIcon(t('map.you_are_here_short'))}
          interactive={false}
          keyboard={false}
          zIndexOffset={SELF_Z_INDEX_OFFSET}
        />
      )}
    </MapContainer>
  );
}

registerMapProvider({ name: 'leaflet', component: LeafletMapProvider });
