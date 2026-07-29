import { renderToStaticMarkup } from 'react-dom/server';
import L from 'leaflet';

/**
 * The user's own "You are here" location marker — a small label pill above a
 * solid contrast dot with a white ring — rendered at whatever location the map
 * is showing for the user (their profile location, or the browser geolocation;
 * see `useUserLocation`). It is a single self-marker, distinct from the item
 * pins, and is never clustered or clickable.
 *
 * Item pins are themed with the network `--primary` colour (often blue), so the
 * self-marker uses a fixed warm accent to stay unmistakable across every
 * network rather than blending into the pins. This module is the single source
 * of truth for that visual, shared by both map providers (Leaflet + Google) so
 * the two surfaces look identical.
 */
export const SELF_MARKER_COLOR = '#f97316'; // orange-500

/** Solid dot diameter (px). */
const DOT = 16;
/** Fixed layout box the pill + dot are absolutely positioned within, so both
 *  providers can anchor the DOT'S CENTRE exactly on the geo point. */
const BOX_W = 120;
const BOX_H = 46;

/**
 * The self-marker visual as inline-styled DOM. Absolute positioning inside a
 * fixed box makes the anchor maths exact and identical in both providers:
 *  - the dot's centre is at (BOX_W/2, BOX_H - DOT/2)
 *  - the pill is centred horizontally, sitting just above the dot.
 * Inline styles (not classes) so `renderToStaticMarkup` produces a
 * self-contained Leaflet divIcon with no external CSS dependency.
 */
export function SelfMarkerContent({ label }: { label: string }) {
  return (
    <div style={{ position: 'relative', width: BOX_W, height: BOX_H, pointerEvents: 'none' }}>
      <span
        style={{
          position: 'absolute',
          left: '50%',
          bottom: DOT + 6,
          transform: 'translateX(-50%)',
          background: SELF_MARKER_COLOR,
          color: '#ffffff',
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.2,
          padding: '2px 6px',
          borderRadius: 6,
          whiteSpace: 'nowrap',
          boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 0,
          transform: 'translateX(-50%)',
          width: DOT,
          height: DOT,
          borderRadius: '50%',
          background: SELF_MARKER_COLOR,
          border: '2px solid #ffffff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
        }}
      />
    </div>
  );
}

/**
 * Leaflet divIcon for the self-marker. `iconAnchor` places the DOT'S CENTRE on
 * the geo point (BOX_H - DOT/2 from the top). Non-interactive at the icon
 * level; the `<Marker>` is also created with `interactive={false}`.
 */
export function createSelfMarkerDivIcon(label: string): L.DivIcon {
  return L.divIcon({
    html: renderToStaticMarkup(<SelfMarkerContent label={label} />),
    className: '',
    iconSize: [BOX_W, BOX_H],
    iconAnchor: [BOX_W / 2, BOX_H - DOT / 2],
  });
}

/**
 * Downward shift (px) the Google provider applies to the content so that
 * AdvancedMarker's default bottom-centre anchoring lands the DOT'S CENTRE — not
 * its bottom — on the geo point (the dot bottom sits at the box bottom).
 */
export const SELF_MARKER_GOOGLE_OFFSET_Y = DOT / 2;
