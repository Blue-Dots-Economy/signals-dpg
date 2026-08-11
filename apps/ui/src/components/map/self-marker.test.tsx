import { describe, it, expect } from 'vitest';
import {
  createSelfMarkerDivIcon,
  SELF_MARKER_COLOR,
  SELF_MARKER_GOOGLE_OFFSET_Y,
} from './self-marker';

describe('createSelfMarkerDivIcon', () => {
  it('renders the given label into the divIcon html', () => {
    const icon = createSelfMarkerDivIcon('You');
    expect(String(icon.options.html)).toContain('You');
  });

  it('uses the contrast self-marker colour (not a themed --primary)', () => {
    const icon = createSelfMarkerDivIcon('You');
    expect(String(icon.options.html)).toContain(SELF_MARKER_COLOR);
  });

  it('anchors the dot centre on the geo point (horizontally centred)', () => {
    const icon = createSelfMarkerDivIcon('You');
    const [w, h] = icon.options.iconSize as [number, number];
    const [ax, ay] = icon.options.iconAnchor as [number, number];
    // Horizontal anchor is the box centre.
    expect(ax).toBe(w / 2);
    // Vertical anchor sits half a dot above the box bottom (the dot centre).
    expect(ay).toBeLessThan(h);
    expect(h - ay).toBe(SELF_MARKER_GOOGLE_OFFSET_Y);
  });

  it('escapes an untrusted label so it cannot inject markup', () => {
    const icon = createSelfMarkerDivIcon('<img src=x onerror=alert(1)>');
    // renderToStaticMarkup escapes the label → no raw <img> tag in the html.
    expect(String(icon.options.html)).not.toContain('<img');
  });
});
