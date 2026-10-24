import { renderToStaticMarkup } from 'react-dom/server';
import L from 'leaflet';

/**
 * The "You are here" marker, shared by both map providers. It uses a fixed
 * warm accent rather than the network `--primary` so it never blends into the
 * item pins.
 */
export const SELF_MARKER_COLOR = '#f97316'; // orange-500

const DOT = 16;
/** Fixed box so both providers can anchor the dot's centre on the point. */
const BOX_W = 120;
const BOX_H = 46;

/**
 * The dot's centre is at (BOX_W/2, BOX_H - DOT/2). Inline styles so
 * `renderToStaticMarkup` yields a self-contained Leaflet divIcon.
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

/** Leaflet divIcon for the self-marker, anchored at the dot's centre. */
export function createSelfMarkerDivIcon(label: string): L.DivIcon {
  return L.divIcon({
    html: renderToStaticMarkup(<SelfMarkerContent label={label} />),
    className: '',
    iconSize: [BOX_W, BOX_H],
    iconAnchor: [BOX_W / 2, BOX_H - DOT / 2],
  });
}

/**
 * Downward shift (px) so AdvancedMarker's bottom-centre anchor lands on the
 * dot's centre rather than its bottom.
 */
export const SELF_MARKER_GOOGLE_OFFSET_Y = DOT / 2;
