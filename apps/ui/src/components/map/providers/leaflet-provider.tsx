import * as React from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
} from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MapMarker, MapProviderProps } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { getIconForDomain } from '../domain-icons';
import { FitBounds } from '../fit-bounds';
import { MarkerPopupCard } from '../marker-popup-card';

import 'leaflet/dist/leaflet.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.Default.css';

/**
 * Imperatively pans/zooms the Leaflet map whenever the `center` or `zoom`
 * props change. Used when the caller manages the viewport explicitly (e.g.
 * when the user picks a different own profile from the selector).
 * Renders nothing — pure side-effect component.
 */
function SetView({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  const prevCenter = React.useRef<[number, number] | null>(null);
  const prevZoom = React.useRef<number | null>(null);

  React.useEffect(() => {
    const sameCenter =
      prevCenter.current !== null &&
      prevCenter.current[0] === center[0] &&
      prevCenter.current[1] === center[1];
    const sameZoom = prevZoom.current === zoom;

    if (!sameCenter || !sameZoom) {
      map.setView(center, zoom);
    }

    prevCenter.current = center;
    prevZoom.current = zoom;
  }, [center, zoom, map]);

  return null;
}

/**
 * Reads a CSS custom property from <html> (where the per-network theme sets
 * --primary / --primary-foreground). Falls back to a sensible default if the
 * variable is unset or we're in a non-DOM context.
 */
function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Builds a Leaflet divIcon for a given marker.  The icon is a 32 × 32 px
 * circle with the precision-based colour as background and the domain lucide
 * icon as a white SVG glyph in the centre.  A small drop-shadow triangle
 * anchors it visually to the map point.
 *
 * Icons are NOT cached globally because each marker may have a unique domain +
 * precision combination.  The overhead is minimal — renderToStaticMarkup on
 * a tiny SVG is fast and happens only once per marker on mount.
 */
function createMarkerDivIcon(marker: MapMarker): L.DivIcon {
  // Network-derived colours: same --primary / --primary-foreground the rest of
  // the UI is themed with (blue_dot → blue, purple_dot → purple, …).
  // Neutral gray fallback (not a specific network's brand colour) if unresolved.
  const bg = readCssVar('--primary', '#6b7280');
  const iconColor = readCssVar('--primary-foreground', '#ffffff');
  const IconComponent = getIconForDomain(marker.domain);

  // Render lucide icon to a static SVG string (16 × 16).
  const svgString = renderToStaticMarkup(
    React.createElement(IconComponent, {
      size: 16,
      color: iconColor,
      strokeWidth: 2,
    })
  );

  // Outer div: circle + pointer triangle via border trick.
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
    // The visual anchor point is the bottom-left corner of the rotated square
    // (which is the pointy tip of the teardrop shape).
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -34],
    className: '', // Clear Leaflet's default white-box class
  });
}

/**
 * Builds the cluster bubble icon (shown when overlapping markers collapse into
 * a count). Uses the active network theme colours (--primary /
 * --primary-foreground) instead of leaflet.markercluster's default blue/green.
 */
function createClusterDivIcon(cluster: { getChildCount: () => number }): L.DivIcon {
  const count = cluster.getChildCount();
  // Neutral gray fallback (not a specific network's brand colour) if unresolved.
  const bg = readCssVar('--primary', '#6b7280');
  const fg = readCssVar('--primary-foreground', '#ffffff');
  const size = count < 10 ? 34 : count < 100 ? 40 : 46;

  const html = `
    <div style="
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
    ">${count}</div>
  `.trim();

  return L.divIcon({
    html,
    className: '',
    iconSize: L.point(size, size),
  });
}



export function LeafletMapProvider({
  center,
  zoom,
  markers,
  onMarkerClick,
  initialViewSet = false,
}: MapProviderProps) {
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className="h-full w-full rounded-lg"
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds markers={markers} skip={initialViewSet} />
      {initialViewSet && <SetView center={center} zoom={zoom} />}
      {/*
       * MarkerClusterGroup wraps all markers so that:
       *  - at low zoom levels, nearby markers collapse into a cluster badge
       *    showing the count (handled by leaflet.markercluster internals).
       *  - at maximum zoom (or when all overlapping markers share the exact
       *    same coordinate), the group spiderfies them so every pin is
       *    individually clickable.
       * spiderfyOnMaxZoom + zoomToBoundsOnClick are both true by default in
       * leaflet.markercluster; we set them explicitly for clarity.
       */}
      <MarkerClusterGroup
        chunkedLoading
        spiderfyOnMaxZoom
        zoomToBoundsOnClick
        maxClusterRadius={80}
        iconCreateFunction={createClusterDivIcon}
      >
        {markers.map((marker) => {
          const icon = createMarkerDivIcon(marker);

          return (
            <Marker
              key={marker.id}
              position={[marker.lat, marker.lng]}
              icon={icon}
              eventHandlers={{
                click: () => onMarkerClick?.(marker.id),
              }}
            >
              <Popup>
                <MarkerPopupCard
                  marker={marker}
                  onViewDetails={onMarkerClick}
                />
              </Popup>
            </Marker>
          );
        })}
      </MarkerClusterGroup>
    </MapContainer>
  );
}

// Self-register on import
registerMapProvider({ name: 'leaflet', component: LeafletMapProvider });
