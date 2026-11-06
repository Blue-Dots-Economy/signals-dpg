import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DivIcon, Point } from 'leaflet';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { MapMarker, MapViewport } from '@/engine/types';

/**
 * Provider-logic tests for the two map providers. Both wrap third-party SDKs
 * (react-leaflet, @vis.gl/react-google-maps), so those modules are mocked
 * wholesale and the assertions target the code the providers actually own:
 * marker/divIcon construction, bubble and pin drawing from the shared
 * clustering module, viewport reporting, the recenter / close-popup nonce
 * guards, popup wiring and registry registration.
 *
 * The mocks communicate with the tests through a bridge object hung off
 * `globalThis` — vi.mock factories are hoisted above every top-level
 * declaration in this file, so they must not close over module-scope bindings
 * (TDZ), only look the bridge up lazily at render time.
 */

interface RenderRecord {
  kind: string;
  props: Record<string, unknown>;
  /** The underlying "SDK object" the mock handed to a `ref` (L.Marker / AdvancedMarkerElement stand-in). */
  el?: object;
}

interface TestBridge {
  /** Fake L.Map returned by react-leaflet's useMap(). */
  map: unknown;
  /** Fake google.maps.Map returned by vis.gl's useMap(). */
  gmap: unknown;
  isMobile: boolean;
  themeMode: 'light' | 'dark';
  records: RenderRecord[];
}

type BridgeHost = { __dpgMapTestBridge: TestBridge };

const bridge = (): TestBridge => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;

(globalThis as unknown as BridgeHost).__dpgMapTestBridge = {
  map: null,
  gmap: null,
  isMobile: false,
  themeMode: 'light',
  records: [],
};

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/theme/mode-provider', () => {
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  return {
    useThemeMode: () => ({
      mode: host().themeMode,
      resolved: host().themeMode,
      setMode: () => {},
    }),
  };
});

// Partial stub: only the one method the providers call. `test/setup.ts` guards
// its between-test dismissal on `toast.getToasts` existing, so a partial mock
// here is expected and safe.
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));

vi.mock('@/hooks/use-mobile', () => {
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  return { useIsMobile: () => host().isMobile };
});

vi.mock('react-leaflet', async () => {
  const React_ = await import('react');
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  const rec = (kind: string, props: Record<string, unknown>, el?: object) => {
    host().records.push({ kind, props, el });
  };

  const MapContainer = (props: Record<string, unknown>) => {
    rec('MapContainer', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'leaflet-map' },
      props.children as React.ReactNode,
    );
  };

  const TileLayer = (props: Record<string, unknown>) => {
    rec('TileLayer', props);
    return React_.createElement('div', {
      'data-testid': 'tile-layer',
      'data-url': String(props.url ?? ''),
      'data-attribution': String(props.attribution ?? ''),
    });
  };

  const Marker = (props: Record<string, unknown>) => {
    // One stable stand-in per mounted <Marker>, mirroring the single L.Marker
    // instance react-leaflet hands to a ref callback.
    const instanceRef = React_.useRef<{ leafletMarker: true } | null>(null);
    instanceRef.current ??= { leafletMarker: true };
    const instance = instanceRef.current;
    rec('Marker', props, instance);

    const refProp = props.ref;
    React_.useEffect(() => {
      if (typeof refProp === 'function') (refProp as (m: object) => void)(instance);
    }, [refProp, instance]);

    const handlers = props.eventHandlers as { click?: () => void; popupopen?: () => void } | undefined;
    return React_.createElement(
      'div',
      {
        'data-testid': 'leaflet-marker',
        onClick: () => {
          handlers?.click?.();
          handlers?.popupopen?.();
        },
      },
      props.children as React.ReactNode,
    );
  };

  const Popup = (props: Record<string, unknown>) => {
    rec('Popup', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'leaflet-popup' },
      props.children as React.ReactNode,
    );
  };

  const useMapEvents = (handlers: Record<string, () => void>) => {
    const map = host().map as {
      on: (event: string, handler: () => void) => void;
      off: (event: string, handler: () => void) => void;
    };
    React_.useEffect(() => {
      for (const [event, handler] of Object.entries(handlers)) map.on(event, handler);
      return () => {
        for (const [event, handler] of Object.entries(handlers)) map.off(event, handler);
      };
    }, [map, handlers]);
    return map;
  };

  return { MapContainer, TileLayer, Marker, Popup, useMap: () => host().map, useMapEvents };
});

vi.mock('@vis.gl/react-google-maps', async () => {
  const React_ = await import('react');
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  const rec = (kind: string, props: Record<string, unknown>, el?: object) => {
    host().records.push({ kind, props, el });
  };

  const APIProvider = (props: Record<string, unknown>) => {
    rec('APIProvider', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'api-provider', 'data-api-key': String(props.apiKey ?? '') },
      props.children as React.ReactNode,
    );
  };

  const Map_ = (props: Record<string, unknown>) => {
    rec('GMap', props);
    return React_.createElement(
      'div',
      {
        'data-testid': 'google-map',
        onClick: props.onClick as (() => void) | undefined,
      },
      props.children as React.ReactNode,
    );
  };

  const AdvancedMarker = (props: Record<string, unknown>) => {
    const elRef = React_.useRef<HTMLElement | null>(null);
    if (elRef.current === null) {
      const el = document.createElement('div');
      el.setAttribute('data-advanced-marker', String(props.title ?? ''));
      elRef.current = el;
    }
    const el = elRef.current;
    rec('AdvancedMarker', props, el);

    const refProp = props.ref;
    React_.useEffect(() => {
      if (typeof refProp === 'function') (refProp as (m: object | null) => void)(el);
    }, [refProp, el]);

    // Non-clickable markers (the "You are here" self-marker) are decoration:
    // they are not focusable and never receive a click, matching the real
    // `clickable={false}` + pointer-events:none wiring.
    if (props.clickable === false) {
      return React_.createElement(
        'div',
        { 'data-testid': 'gmap-self-marker', 'aria-label': String(props.title ?? '') },
        props.children as React.ReactNode,
      );
    }

    return React_.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'gmap-marker',
        'aria-label': String(props.title ?? ''),
        onClick: (e: React.MouseEvent) => {
          // Google Maps marker clicks do not bubble to the map's own click
          // handler; emulate that so the provider's "click empty map closes the
          // popup" path can be exercised without a marker click undoing itself.
          e.stopPropagation();
          (props.onClick as (() => void) | undefined)?.();
        },
      },
      props.children as React.ReactNode,
    );
  };

  const InfoWindow = (props: Record<string, unknown>) => {
    rec('InfoWindow', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'info-window' },
      React_.createElement('button', {
        type: 'button',
        'aria-label': 'Close info window',
        onClick: props.onCloseClick as (() => void) | undefined,
      }),
      props.children as React.ReactNode,
    );
  };

  const useAdvancedMarkerRef = () => {
    const [el, setEl] = React_.useState<HTMLElement | null>(null);
    const ref = React_.useCallback((node: HTMLElement | null) => setEl(node), []);
    return [ref, el] as const;
  };

  return {
    APIProvider,
    Map: Map_,
    AdvancedMarker,
    InfoWindow,
    ColorScheme: { DARK: 'DARK', LIGHT: 'LIGHT' },
    useAdvancedMarkerRef,
    useMap: () => host().gmap,
  };
});

// Imported AFTER the mocks are declared; importing each provider is also what
// self-registers it with the map registry.
import L from 'leaflet';
import { LeafletMapProvider, createClusterDivIcon } from '../leaflet-provider';
import { GoogleMapProvider } from '../google-maps-provider';
import {
  getRegisteredProviders,
  getActiveMapProvider,
  setActiveMapProvider,
} from '@/engine/map/map-registry';

// ─── Fixtures & fakes ────────────────────────────────────────────────────────

const COLOURS = { bg: '#123456', fg: '#ffffff' };

const ALPHA: MapMarker = {
  id: 'alpha',
  lat: 19.1,
  lng: 72.9,
  label: 'Alpha Academy',
  // Deliberately does NOT repeat the label: the popup card's heading comes from
  // `label`, while `data` drives the field rows, so tests can tell them apart.
  data: { headline: 'Alpha headline' },
  precision: 'exact',
  domain: 'seeker',
};

const BETA: MapMarker = {
  id: 'beta',
  lat: 19.2,
  lng: 72.8,
  label: 'Beta Institute',
  data: { headline: 'Beta headline' },
  precision: 'geocoded_full_address',
  domain: 'provider',
};

const GAMMA: MapMarker = {
  id: 'gamma',
  lat: 19.3,
  lng: 72.7,
  label: 'Gamma Learners',
  data: { headline: 'Gamma headline' },
  precision: 'exact',
  domain: 'seeker',
};

/** Fake L.Map: only the surface the Leaflet provider actually calls. */
function createFakeLeafletMap(opts?: { boundsValid?: boolean; zoom?: number }) {
  const state = { zoom: opts?.zoom ?? 11 };
  const listeners = new Map<string, Set<() => void>>();
  const bounds = {
    isValid: () => opts?.boundsValid ?? true,
    getNorthEast: () => ({ lat: 19.5, lng: 73.5 }),
    getSouthWest: () => ({ lat: 18.5, lng: 71.5 }),
  };
  return {
    setView: vi.fn((_center: [number, number], zoom: number) => {
      state.zoom = zoom;
    }),
    fitBounds: vi.fn((_bounds: Array<[number, number]>, _options?: unknown) => {}),
    closePopup: vi.fn(() => {}),
    getCenter: () => ({ lat: 19, lng: 72.5 }),
    getBounds: () => bounds,
    getZoom: () => state.zoom,
    on: vi.fn((event: string, handler: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(handler);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    }),
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    fire: (event: string) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
  };
}

/** Fake google.maps.Map: only the surface the Google provider actually calls. */
function createFakeGoogleMap(opts?: { zoom?: number; hasBounds?: boolean }) {
  const listeners: Record<string, Array<() => void>> = {};
  const removed: string[] = [];
  const camera = { lat: 19, lng: 72.5, zoom: opts?.zoom ?? 11 };
  const div = document.createElement('div');
  return {
    camera,
    listeners,
    removed,
    div,
    getDiv: () => div,
    getCenter: () => ({ lat: () => camera.lat, lng: () => camera.lng }),
    getZoom: () => camera.zoom,
    getBounds: () =>
      opts?.hasBounds === false
        ? null
        : {
            getNorthEast: () => ({ lat: () => 19.5, lng: () => 73.5 }),
            getSouthWest: () => ({ lat: () => 18.5, lng: () => 71.5 }),
          },
    panTo: vi.fn((_point: { lat: number; lng: number }) => {}),
    setZoom: vi.fn((_zoom: number) => {}),
    panBy: vi.fn((_x: number, _y: number) => {}),
    moveCamera: vi.fn((_camera: { center: { lat: number; lng: number }; zoom: number }) => {}),
    addListener: vi.fn((event: string, handler: () => void) => {
      (listeners[event] ??= []).push(handler);
      return { remove: () => removed.push(event) };
    }),
    fire: (event: string) => {
      for (const handler of [...(listeners[event] ?? [])]) handler();
    },
  };
}

/** Controllable ResizeObserver so the Google InfoWindow's fit-in-view path is testable. */
interface ObserverSpy {
  callback: () => void;
  node: Element | null;
}
const resizeObservers: ObserverSpy[] = [];
class StubResizeObserver {
  private readonly spy: ObserverSpy;
  constructor(callback: () => void) {
    this.spy = { callback, node: null };
    resizeObservers.push(this.spy);
  }
  observe(node: Element) {
    this.spy.node = node;
  }
  unobserve() {}
  disconnect() {}
}

/**
 * Pins an element's client rect (happy-dom reports all zeroes) and returns the
 * live rect object so a test can grow/shrink the element afterwards.
 */
function stubRect(node: Element, initial: { top: number; bottom: number; height: number }) {
  const rect = { ...initial };
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        ...rect,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return rect;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function recordsOf(kind: string): RenderRecord[] {
  return bridge().records.filter((r) => r.kind === kind);
}

function lastProps(kind: string): Record<string, unknown> {
  const list = recordsOf(kind);
  if (list.length === 0) throw new Error(`no ${kind} was rendered`);
  return list[list.length - 1].props;
}

function setRuntimeConfig(config: Record<string, string> | undefined): void {
  const host = window as unknown as { __DPG_UI_CONFIG__?: Record<string, string> };
  if (config === undefined) delete host.__DPG_UI_CONFIG__;
  else host.__DPG_UI_CONFIG__ = config;
}

let originalResizeObserver: unknown;

beforeEach(() => {
  const b = bridge();
  b.map = null;
  b.gmap = null;
  b.isMobile = false;
  b.themeMode = 'light';
  b.records = [];
  resizeObservers.length = 0;

  const host = globalThis as unknown as { ResizeObserver?: unknown };
  originalResizeObserver = host.ResizeObserver;
  host.ResizeObserver = StubResizeObserver;

  setRuntimeConfig(undefined);
  // The dark-basemap notice is once-per-session; without this reset the first
  // test to render in dark mode would silence every later one.
  sessionStorage.clear();
  vi.mocked(toast.info).mockClear();
});

afterEach(() => {
  const host = globalThis as unknown as { ResizeObserver?: unknown };
  host.ResizeObserver = originalResizeObserver;
  setRuntimeConfig(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // The registry is module-global state; leave it on the documented default so
  // the ordering of these tests can never leak into another file's expectations.
  setActiveMapProvider('leaflet');
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe('map provider registry', () => {
  it('self-registers both providers under their documented names on import', () => {
    expect(getRegisteredProviders()).toEqual(
      expect.arrayContaining(['leaflet', 'google-maps']),
    );
  });

  it('returns the component for whichever provider name is active', () => {
    setActiveMapProvider('google-maps');
    expect(getActiveMapProvider()).toBe(GoogleMapProvider);

    setActiveMapProvider('leaflet');
    expect(getActiveMapProvider()).toBe(LeafletMapProvider);
  });

  it('refuses an unregistered provider name and keeps the previous active provider', () => {
    setActiveMapProvider('leaflet');

    expect(() => setActiveMapProvider('mapbox')).toThrow(/"mapbox" is not registered/);
    expect(getActiveMapProvider()).toBe(LeafletMapProvider);
  });
});

// ─── Leaflet provider ────────────────────────────────────────────────────────

type LeafletProps = React.ComponentProps<typeof LeafletMapProvider>;

const leafletElement = (overrides: Partial<LeafletProps> = {}) => (
  <LeafletMapProvider center={[19, 72.5]} zoom={11} markers={[ALPHA]} {...overrides} />
);

describe('LeafletMapProvider', () => {
  it('renders one marker per item, each with a popup card for that item', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA, BETA], onMarkerClick: vi.fn() }));

    expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(2);
    expect(screen.getByText('Alpha Academy')).toBeInTheDocument();
    expect(screen.getByText('Beta Institute')).toBeInTheDocument();
  });

  it('wires the default popup card back to onMarkerClick as its "View details" action', async () => {
    const onMarkerClick = vi.fn((_id: string) => {});
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA], onMarkerClick }));

    await userEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(onMarkerClick).toHaveBeenCalledWith('alpha');
  });

  it('uses a custom renderPopup instead of the default card when provided', () => {
    bridge().map = createFakeLeafletMap();
    render(
      leafletElement({
        markers: [ALPHA],
        onMarkerClick: vi.fn(),
        renderPopup: (marker) => <p>custom for {marker.label}</p>,
      }),
    );

    expect(screen.getByText('custom for Alpha Academy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View details' })).not.toBeInTheDocument();
  });

  it('reports the clicked marker id to onMarkerClick', async () => {
    const onMarkerClick = vi.fn((_id: string) => {});
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA, BETA], onMarkerClick }));

    await userEvent.click(screen.getAllByTestId('leaflet-marker')[1]);
    expect(onMarkerClick).toHaveBeenCalledWith('beta');
  });

  it('serves the light OSM basemap in light mode', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement());

    const tiles = screen.getByTestId('tile-layer');
    expect(tiles).toHaveAttribute(
      'data-url',
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    );
    expect(tiles.getAttribute('data-attribution')).not.toContain('carto.com');
  });

  // CARTO's `dark_all` is API-key-gated now: a keyless tile still returns 200
  // but arrives watermarked, so dark mode showed a defaced basemap with no
  // failing request to catch it. One light basemap in every theme instead.
  it('keeps the light OSM basemap in dark mode', () => {
    bridge().themeMode = 'dark';
    bridge().map = createFakeLeafletMap();
    render(leafletElement());

    const tiles = screen.getByTestId('tile-layer');
    expect(tiles).toHaveAttribute(
      'data-url',
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    );
    expect(tiles.getAttribute('data-attribution')).not.toContain('carto.com');
  });

  it('explains the light basemap once when the app is in dark mode', () => {
    bridge().themeMode = 'dark';
    bridge().map = createFakeLeafletMap();
    render(leafletElement());

    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.info).mock.calls[0][0]).toContain('OpenStreetMap');
    expect(vi.mocked(toast.info).mock.calls[0][1]).toMatchObject({
      id: 'map-dark-basemap',
    });
  });

  it('stays silent in light mode', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement());

    expect(toast.info).not.toHaveBeenCalled();
  });

  // The map remounts on route changes and on the maximize toggle; re-toasting
  // there would nag.
  it('does not repeat the notice on a later mount in the same session', () => {
    bridge().themeMode = 'dark';
    bridge().map = createFakeLeafletMap();
    const first = render(leafletElement());
    first.unmount();
    render(leafletElement());

    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it('builds a teardrop divIcon anchored on the geo point with the domain glyph inside', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA] }));

    const icon = recordsOf('Marker')[0].props.icon as DivIcon;
    expect(icon.options.iconSize).toEqual([32, 32]);
    expect(icon.options.iconAnchor).toEqual([16, 32]);
    expect(icon.options.popupAnchor).toEqual([0, -34]);
    // Leaflet's default white-box class is cleared so only our HTML shows.
    expect(icon.options.className).toBe('');
    expect(String(icon.options.html)).toContain('<svg');
  });

  it('renders the caller-supplied resolveIcon glyph instead of the domain icon', () => {
    const CustomGlyph = () => <svg data-glyph="custom" />;
    bridge().map = createFakeLeafletMap();
    render(
      leafletElement({
        markers: [ALPHA],
        resolveIcon: () => CustomGlyph as unknown as LucideIcon,
      }),
    );

    const icon = recordsOf('Marker')[0].props.icon as DivIcon;
    expect(String(icon.options.html)).toContain('data-glyph="custom"');
  });

  it('renders the non-interactive "You are here" marker outside the clustering output', () => {
    bridge().map = createFakeLeafletMap();
    const crowd = Array.from({ length: 200 }, (_, i) => at(`crowd-${i}`, 19, 72));
    render(leafletElement({ markers: crowd, selfLocation: { lat: 19, lng: 72.5 } }));

    expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(2);
    const bubble = recordsOf('Marker').find((r) => r.props.interactive !== false)?.props;
    expect(String((bubble?.icon as DivIcon).options.html)).toContain('>200</div>');

    const selfProps =
      recordsOf('Marker').find((r) => r.props.interactive === false)?.props ?? {};
    expect(selfProps.interactive).toBe(false);
    expect(selfProps.keyboard).toBe(false);
    expect(String((selfProps.icon as DivIcon).options.html)).toContain('You');
  });

  it('draws a listing on the viewer\'s own location above the "You are here" marker', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [at('mine', 19, 72.5)], selfLocation: { lat: 19, lng: 72.5 } }));

    const pin = recordsOf('Marker').find((r) => r.props.interactive !== false)?.props ?? {};
    const self = recordsOf('Marker').find((r) => r.props.interactive === false)?.props ?? {};
    expect(Number(pin.zIndexOffset ?? 0)).toBeGreaterThan(Number(self.zIndexOffset ?? 0));
  });

  it('renders no self-marker when the user has no resolved location', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA], selfLocation: null }));

    expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1);
  });

  it('sizes the cluster bubble by count band and shows the total', () => {
    const small = String(createClusterDivIcon(4, [], COLOURS).options.html);
    expect(small).toContain('width: 34px');
    expect(small).toContain('>4</div>');

    expect(String(createClusterDivIcon(42, [], COLOURS).options.html)).toContain('width: 40px');
    expect(String(createClusterDivIcon(150, [], COLOURS).options.html)).toContain('width: 46px');
  });

  it('adds a per-domain badge row (and widens the icon) for a multi-domain cluster', () => {
    const icon = createClusterDivIcon(3, [
      { domain: 'seeker', count: 2 },
      { domain: 'provider', count: 1 },
    ], COLOURS);

    const html = String(icon.options.html);
    expect(html).toContain('>3</div>');
    const chips = html.match(/<span/g) ?? [];
    expect(chips).toHaveLength(2);
    expect(html).toMatch(/>\s*2\s*<\/span>/);

    const size = icon.options.iconSize as Point;
    expect(size.x).toBe(2 * 38 + 3);
    expect(size.y).toBe(34 + 22);
    const anchor = icon.options.iconAnchor as Point;
    expect(anchor.x).toBe(size.x / 2);
    expect(anchor.y).toBe(17);
  });

  it('shows no badge row for a single-domain cluster', () => {
    const icon = createClusterDivIcon(3, [{ domain: 'seeker', count: 3 }], COLOURS);

    expect(String(icon.options.html)).not.toContain('<span');
    const size = icon.options.iconSize as Point;
    expect(size.x).toBe(34);
    expect(size.y).toBe(34);
  });

  it('reads the theme colours once per draw, not once per bubble or pin', async () => {
    bridge().map = createFakeLeafletMap();
    const crowd = Array.from({ length: 200 }, (_, i) => at(`crowd-${i}`, 19, 72));
    const spy = vi.spyOn(window, 'getComputedStyle');

    render(leafletElement({ markers: [...crowd, BETA, GAMMA] }));

    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(3));
    expect(spy.mock.calls.filter(([el]) => el === document.documentElement)).toHaveLength(1);
    spy.mockRestore();
  });

  it('brings a hovered bubble in front of the bubbles it overlaps', async () => {
    bridge().map = createFakeLeafletMap();
    const crowd = Array.from({ length: 7 }, (_, i) => at(`crowd-${i}`, 19, 72));
    render(leafletElement({ markers: crowd }));
    const latest = () => recordsOf('Marker').filter((r) => String((r.props.icon as DivIcon).options.html).includes('>7</div>')).at(-1)!.props;
    await waitFor(() => expect(latest().zIndexOffset).toBe(1007));

    act(() => (latest().eventHandlers as { mouseover: () => void }).mouseover());
    expect(latest().zIndexOffset).toBeGreaterThan(1007 + 1_000_000);
    act(() => (latest().eventHandlers as { mouseout: () => void }).mouseout());
    expect(latest().zIndexOffset).toBe(1007);
  });

  it('draws one marker per visible bubble or pin, not one per listing', async () => {
    bridge().map = createFakeLeafletMap();
    const crowd = Array.from({ length: 200 }, (_, i) => at(`crowd-${i}`, 19, 72));

    render(leafletElement({ markers: [...crowd, BETA, GAMMA] }));

    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(3));
    const bubble = recordsOf('Marker').find((r) => String((r.props.icon as DivIcon).options.html).includes('>200</div>'));
    expect(bubble).toBeDefined();
    expect(screen.getByText('Beta Institute')).toBeInTheDocument();
  });

  it('zooms to the expansion zoom on bubble click', async () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    const crowd = Array.from({ length: 200 }, (_, i) => at(`crowd-${i}`, 19 + (i % 20) * 0.001, 72 + Math.floor(i / 20) * 0.001));
    render(leafletElement({ markers: crowd }));
    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1));
    const bubble = recordsOf('Marker')[0].props;
    expect(bubble.position).toEqual([expect.any(Number), expect.any(Number)]);

    await userEvent.click(screen.getByTestId('leaflet-marker'));

    expect(map.setView).toHaveBeenCalledTimes(1);
    const [latLng, zoom] = map.setView.mock.calls[0];
    expect(latLng).toEqual(bubble.position);
    expect(zoom).toBeGreaterThan(11);
    expect(zoom).toBeLessThanOrEqual(18);
  });

  it('opens a same-spot card on a bubble that cannot split instead of zooming', async () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement({ markers: [at('a', 19, 72), at('b', 19, 72), at('c', 19, 72)] }));
    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1));

    await userEvent.click(screen.getByTestId('leaflet-marker'));

    expect(map.setView).not.toHaveBeenCalled();
    expect(screen.getByText('3 listings at this exact spot')).toBeInTheDocument();
  });

  it('builds the same-spot card from the latest renderSpotGroup when it opens', async () => {
    bridge().map = createFakeLeafletMap();
    const markers = [at('a', 19, 72), at('b', 19, 72)];
    const { rerender } = render(leafletElement({ markers, renderSpotGroup: () => <p>first page state</p> }));
    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1));
    rerender(leafletElement({ markers, renderSpotGroup: () => <p>latest page state</p> }));

    await userEvent.click(screen.getByTestId('leaflet-marker'));

    expect(screen.getByText('latest page state')).toBeInTheDocument();
    expect(screen.queryByText('first page state')).not.toBeInTheDocument();
  });

  it('hands a same-spot bubble to the page when popups are off', async () => {
    bridge().map = createFakeLeafletMap();
    const onSpotGroupSelect = vi.fn();
    render(leafletElement({ markers: [at('a', 19, 72), at('b', 19, 72)], showPopup: false, onSpotGroupSelect }));
    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1));

    await userEvent.click(screen.getByTestId('leaflet-marker'));

    expect(onSpotGroupSelect).toHaveBeenCalledWith(expect.objectContaining({ count: 2, exact: true }));
    expect(screen.queryByTestId('leaflet-popup')).not.toBeInTheDocument();
  });

  it('keeps listings a few metres apart as one bubble at the 18 maximum zoom', async () => {
    bridge().map = createFakeLeafletMap({ zoom: 18 });
    const ring = [at('r1', 19, 72), at('r2', 19.00005, 72), at('r3', 19, 72.00005)];

    render(leafletElement({ markers: ring }));

    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1));
  });

  it('reuses one icon per glyph', () => {
    const UniqueGlyph = () => <svg data-glyph="unique" />;
    const divIcon = vi.spyOn(L, 'divIcon');
    bridge().map = createFakeLeafletMap();

    render(
      leafletElement({
        markers: [ALPHA, BETA],
        resolveIcon: () => UniqueGlyph as unknown as LucideIcon,
      }),
    );

    const icons = recordsOf('Marker').map((r) => r.props.icon);
    expect(icons[0]).toBe(icons[1]);
    expect(divIcon).toHaveBeenCalledTimes(1);
  });

  it('does not re-render a pin when the caller passes new inline callbacks', () => {
    bridge().map = createFakeLeafletMap();
    const { rerender } = render(
      leafletElement({ markers: [ALPHA], renderPopup: (m) => <p>{m.label}</p>, onMarkerClick: () => {} }),
    );
    const before = recordsOf('Marker').length;

    rerender(leafletElement({ markers: [ALPHA], renderPopup: (m) => <p>{m.label}</p>, onMarkerClick: () => {} }));

    expect(recordsOf('Marker')).toHaveLength(before);
  });

  it('shows the latest renderPopup in an open popup without re-rendering the pin', () => {
    bridge().map = createFakeLeafletMap();
    const { rerender } = render(leafletElement({ markers: [ALPHA], renderPopup: (m) => <p>old {m.label}</p> }));
    expect(screen.getByText('old Alpha Academy')).toBeInTheDocument();
    const pinRenders = recordsOf('Marker').length;

    rerender(leafletElement({ markers: [ALPHA], renderPopup: (m) => <p>new {m.label}</p> }));

    expect(screen.getByText('new Alpha Academy')).toBeInTheDocument();
    expect(recordsOf('Marker')).toHaveLength(pinRenders);
  });

  it('stacks a bubble above the pins', async () => {
    bridge().map = createFakeLeafletMap();
    const crowd = Array.from({ length: 200 }, (_, i) => at(`crowd-${i}`, 19, 72));
    render(leafletElement({ markers: crowd }));
    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1));

    expect(recordsOf('Marker')[0].props.zIndexOffset).toBe(1200);
  });

  it('listens for moveend and zoomend to re-cluster', async () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement({ markers: [ALPHA, BETA] }));
    await waitFor(() => expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(2));

    expect(map.listenerCount('moveend')).toBe(1);
    expect(map.listenerCount('zoomend')).toBe(1);
  });

  it('drives the camera to the caller viewport when a specific profile is selected', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    const { rerender } = render(leafletElement({ initialViewSet: true, focusNonce: 1 }));

    expect(map.setView).toHaveBeenCalledWith([19, 72.5], 11);

    // Same center/zoom/nonce → no second setView (never fights user panning).
    rerender(leafletElement({ initialViewSet: true, focusNonce: 1 }));
    expect(map.setView).toHaveBeenCalledTimes(1);

    // A nonce bump is an explicit recenter intent even for an unchanged point.
    rerender(leafletElement({ initialViewSet: true, focusNonce: 2 }));
    expect(map.setView).toHaveBeenCalledTimes(2);

    // A changed center recenters too.
    rerender(leafletElement({ initialViewSet: true, focusNonce: 2, center: [20, 73] }));
    expect(map.setView).toHaveBeenLastCalledWith([20, 73], 11);
  });

  it('fits all markers when no explicit viewport is set', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement({ markers: [ALPHA, BETA] }));

    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [19.1, 72.9],
        [19.2, 72.8],
      ],
      { padding: [50, 50] },
    );
    expect(map.setView).not.toHaveBeenCalled();
  });

  it('skips bounds-fitting in viewport-markers mode so fit and fetch cannot loop', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement({ markers: [ALPHA, BETA], onViewportChange: vi.fn() }));

    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(map.setView).not.toHaveBeenCalled();
  });

  it('emits the current viewport (bbox + zoom) once on mount', () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    const map = createFakeLeafletMap({ zoom: 13 });
    bridge().map = map;
    render(leafletElement({ onViewportChange }));

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    const viewport = onViewportChange.mock.calls[0][0];
    expect(viewport).toEqual(
      expect.objectContaining({
        lat: 19,
        lng: 72.5,
        minLat: 18.5,
        minLng: 71.5,
        maxLat: 19.5,
        maxLng: 73.5,
        zoom: 13,
      }),
    );
    expect(viewport.radiusMeters).toBeGreaterThan(0);
  });

  it('re-emits on debounced moveend and detaches the listener on unmount', async () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    const map = createFakeLeafletMap();
    bridge().map = map;
    const { unmount } = render(leafletElement({ onViewportChange }));

    expect(map.listenerCount('moveend')).toBe(2);
    onViewportChange.mockClear();

    act(() => map.fire('moveend'));
    // Debounced — nothing yet.
    expect(onViewportChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1));

    unmount();
    expect(map.listenerCount('moveend')).toBe(0);
    expect(map.listenerCount('zoomend')).toBe(0);
  });

  it('skips the mount emit while the map bounds are not yet valid, but still emits on moveend', async () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    const map = createFakeLeafletMap({ boundsValid: false });
    bridge().map = map;
    render(leafletElement({ onViewportChange }));

    expect(onViewportChange).not.toHaveBeenCalled();

    act(() => map.fire('moveend'));
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1));
  });

  it('attaches no viewport reporter when the caller wants no viewport reports', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement());

    expect(map.listenerCount('moveend')).toBe(1);
  });

  it('closes the open popup only when closePopupNonce actually changes', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    const { rerender } = render(leafletElement({ closePopupNonce: 3 }));

    // Mounting with a nonce already set must not fire a spurious close.
    expect(map.closePopup).not.toHaveBeenCalled();

    rerender(leafletElement({ closePopupNonce: 3 }));
    expect(map.closePopup).not.toHaveBeenCalled();

    rerender(leafletElement({ closePopupNonce: 4 }));
    expect(map.closePopup).toHaveBeenCalledTimes(1);
  });

  it('gives the popup a fixed 300px width and no Leaflet close button', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA] }));

    const popup = lastProps('Popup');
    expect(popup.closeButton).toBe(false);
    expect(popup.minWidth).toBe(300);
    expect(popup.maxWidth).toBe(300);
  });
});

// ─── Google provider ─────────────────────────────────────────────────────────

type GoogleProps = React.ComponentProps<typeof GoogleMapProvider>;

const googleElement = (overrides: Partial<GoogleProps> = {}) => (
  <GoogleMapProvider center={[19, 72.5]} zoom={11} markers={[ALPHA]} {...overrides} />
);

/** Configures the API key the way a deployment does — through /config.js. */
function configureApiKey(): void {
  setRuntimeConfig({ VITE_GOOGLE_MAPS_API_KEY: 'test-key' });
}

/** A pin at a given spot, built from ALPHA. */
const at = (id: string, lat: number, lng: number, domain = 'seeker'): MapMarker => ({
  ...ALPHA,
  id,
  label: id,
  lat,
  lng,
  domain,
});


describe('GoogleMapProvider', () => {
  it('renders a configuration hint instead of a map when no API key is available', () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
    setRuntimeConfig(undefined);

    render(googleElement());

    expect(screen.getByText('Google Maps provider not configured.')).toBeInTheDocument();
    expect(screen.getByText(/VITE_GOOGLE_MAPS_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByTestId('google-map')).not.toBeInTheDocument();
  });

  it('boots the map from the runtime-config API key with the vector map + custom controls', () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(screen.getByTestId('api-provider')).toHaveAttribute('data-api-key', 'test-key');
    const props = lastProps('GMap');
    expect(props.defaultCenter).toEqual({ lat: 19, lng: 72.5 });
    expect(props.defaultZoom).toBe(11);
    expect(props.mapId).toBe('dpg-items-map');
    // Native fullscreen would hide the app's own map overlay controls.
    expect(props.fullscreenControl).toBe(false);
    expect(props.colorScheme).toBe('LIGHT');
  });

  it('constructs a dark-scheme map when the app theme is dark', () => {
    configureApiKey();
    bridge().themeMode = 'dark';
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(lastProps('GMap').colorScheme).toBe('DARK');
    // Google has a real dark basemap, so the Leaflet-only notice must not fire.
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('collapses the Map/Satellite control into a dropdown on mobile', () => {
    configureApiKey();
    bridge().isMobile = true;
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(lastProps('GMap').mapTypeControlOptions).toEqual({ style: 2 });
  });

  it("keeps Google's default Map/Satellite bar on desktop", () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(lastProps('GMap').mapTypeControlOptions).toBeUndefined();
  });

  it('draws one marker per visible bubble or pin, not one per listing', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const crowd = Array.from({ length: 200 }, (_, i) => at(`crowd-${i}`, 19, 72));

    render(googleElement({ markers: [...crowd, BETA, GAMMA] }));

    await waitFor(() => expect(screen.getAllByTestId('gmap-marker')).toHaveLength(3));
    expect(screen.getByRole('button', { name: '200' })).toBeInTheDocument();
    expect(recordsOf('AdvancedMarker').find((r) => r.props.title === 'Beta Institute')?.props.zIndex).toBe(500);
  });

  it('removes a pin that drops out of the marker set', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { rerender } = render(googleElement({ markers: [ALPHA, BETA] }));
    await waitFor(() => expect(screen.getAllByTestId('gmap-marker')).toHaveLength(2));

    rerender(googleElement({ markers: [ALPHA] }));

    expect(screen.getAllByTestId('gmap-marker')).toHaveLength(1);
  });

  it('re-renders only the clicked pin when its popup opens', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA, BETA] }));
    await waitFor(() => expect(screen.getAllByTestId('gmap-marker')).toHaveLength(2));
    const betaRenders = () => recordsOf('AdvancedMarker').filter((r) => r.props.title === 'Beta Institute').length;
    const before = betaRenders();

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    expect(screen.getByTestId('info-window')).toBeInTheDocument();
    expect(betaRenders()).toBe(before);
  });

  it('shows the latest renderPopup in an open InfoWindow', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { rerender } = render(googleElement({ markers: [ALPHA], renderPopup: (m) => <p>old {m.label}</p> }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    expect(screen.getByText('old Alpha Academy')).toBeInTheDocument();

    rerender(googleElement({ markers: [ALPHA], renderPopup: (m) => <p>new {m.label}</p> }));

    expect(screen.getByText('new Alpha Academy')).toBeInTheDocument();
  });

  it('does not reopen a popup when its pin leaves the drawn set and comes back', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { rerender } = render(googleElement({ markers: [ALPHA, BETA] }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    expect(screen.getByTestId('info-window')).toBeInTheDocument();

    rerender(googleElement({ markers: [BETA] }));
    await waitFor(() => expect(screen.queryByTestId('info-window')).not.toBeInTheDocument());
    rerender(googleElement({ markers: [ALPHA, BETA] }));

    expect(screen.getAllByTestId('gmap-marker')).toHaveLength(2);
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('opens an InfoWindow anchored to the clicked pin, and toggles it shut on a second click', async () => {
    const onMarkerClick = vi.fn((_id: string) => {});
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA], onMarkerClick }));

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    expect(screen.getByTestId('info-window')).toBeInTheDocument();
    expect(screen.getByText('Alpha headline')).toBeInTheDocument();
    expect(onMarkerClick).toHaveBeenCalledWith('alpha');
    const info = lastProps('InfoWindow');
    expect(info.headerDisabled).toBe(true);
    // Above every pin and cluster bubble, so they never paint over the card.
    expect(info.zIndex).toBe(1_000_000);
    expect(info.anchor).toBe(
      recordsOf('AdvancedMarker').find((r) => r.props.clickable !== false)?.el,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it.each([
    ['a positive integer', '5000', 5000],
    ['a non-number', 'abc', 1_000_000],
    ['a negative number', '-1', 1_000_000],
    ['a fraction', '1.5', 1_000_000],
  ])('reads the InfoWindow zIndex from VITE_MAP_POPUP_Z_INDEX (%s)', async (_label, raw, expected) => {
    setRuntimeConfig({ VITE_GOOGLE_MAPS_API_KEY: 'test-key', VITE_MAP_POPUP_Z_INDEX: raw });
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA] }));

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    expect(lastProps('InfoWindow').zIndex).toBe(expected);
  });

  it("closes the InfoWindow from Google's own close affordance", async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA] }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    await userEvent.click(screen.getByRole('button', { name: 'Close info window' }));

    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('shows a centered modal card (not an InfoWindow) on mobile, dismissable by its backdrop', async () => {
    configureApiKey();
    bridge().isMobile = true;
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA] }));

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Alpha headline')).toBeInTheDocument();
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the open popup when the user clicks empty map area', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA] }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    expect(screen.getByTestId('info-window')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('google-map'));

    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('closes the open popup when closePopupNonce is bumped, but not on mount', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { rerender } = render(googleElement({ markers: [ALPHA], closePopupNonce: 1 }));

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    rerender(googleElement({ markers: [ALPHA], closePopupNonce: 1 }));
    expect(screen.getByTestId('info-window')).toBeInTheDocument();

    rerender(googleElement({ markers: [ALPHA], closePopupNonce: 2 }));
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('re-centres the camera on an explicit viewport, and again on a focusNonce bump', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;
    const { rerender } = render(googleElement({ initialViewSet: true, focusNonce: 1 }));

    expect(gmap.panTo).toHaveBeenCalledWith({ lat: 19, lng: 72.5 });
    expect(gmap.setZoom).toHaveBeenCalledWith(11);

    rerender(googleElement({ initialViewSet: true, focusNonce: 1 }));
    expect(gmap.panTo).toHaveBeenCalledTimes(1);

    rerender(googleElement({ initialViewSet: true, focusNonce: 2 }));
    expect(gmap.panTo).toHaveBeenCalledTimes(2);
  });

  it('leaves the camera alone in fit-all mode (no explicit viewport)', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;

    render(googleElement({ initialViewSet: false }));

    expect(gmap.panTo).not.toHaveBeenCalled();
    expect(gmap.setZoom).not.toHaveBeenCalled();
  });

  it('emits the viewport on mount and on debounced idle, listening only when asked to', async () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom: 14 });
    bridge().gmap = gmap;

    render(googleElement({ onViewportChange }));

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    expect(onViewportChange.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        lat: 19,
        lng: 72.5,
        minLat: 18.5,
        minLng: 71.5,
        maxLat: 19.5,
        maxLng: 73.5,
        zoom: 14,
      }),
    );
    // Viewport reporter, camera tracker and cluster view.
    expect(gmap.listeners.idle).toHaveLength(3);

    onViewportChange.mockClear();
    act(() => gmap.fire('idle'));
    expect(onViewportChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1));
  });

  it('attaches no viewport listener at all when the caller wants no reports', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;

    render(googleElement());

    // Camera tracker and cluster view only — the tourist app attaches no reporter.
    expect(gmap.listeners.idle).toHaveLength(2);
  });

  it('reports nothing while the map has no bounds yet', () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    configureApiKey();
    const gmap = createFakeGoogleMap({ hasBounds: false });
    bridge().gmap = gmap;

    render(googleElement({ onViewportChange }));
    expect(onViewportChange).not.toHaveBeenCalled();

    act(() => gmap.fire('idle'));
    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('renders the self-marker below the pins, non-clickable and outside clustering', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();

    render(googleElement({ markers: [ALPHA], selfLocation: { lat: 19, lng: 72.5 } }));
    await waitFor(() => expect(screen.getAllByTestId('gmap-marker')).toHaveLength(1));

    const selfRecord = recordsOf('AdvancedMarker').find((r) => r.props.clickable === false);
    const itemRecord = recordsOf('AdvancedMarker').find((r) => r.props.clickable !== false);
    expect(selfRecord?.props.zIndex).toBe(0);
    expect(itemRecord?.props.zIndex).toBe(500);
    expect(selfRecord?.props.style).toEqual({ pointerEvents: 'none' });

    const selfMarker = screen.getByTestId('gmap-self-marker');
    expect(selfMarker).toHaveAttribute('aria-label', 'You');
    expect(within(selfMarker).getByText('You')).toBeInTheDocument();
  });

  it('brings a hovered bubble in front of the bubbles it overlaps, below the popup', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const crowd = Array.from({ length: 7 }, (_, i) => at(`crowd-${i}`, 19, 72));
    render(googleElement({ markers: crowd }));
    const latest = () => recordsOf('AdvancedMarker').filter((r) => r.props.title === '7').at(-1)!.props;
    await waitFor(() => expect(latest().zIndex).toBe(1007));

    act(() => (latest().onMouseEnter as () => void)());
    expect(latest().zIndex).toBe(999_999);
    act(() => (latest().onMouseLeave as () => void)());
    expect(latest().zIndex).toBe(1007);
  });

  it('themes the cluster bubble with the total, sized by count band', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const spot = (n: number) => Array.from({ length: n }, (_, i) => at(`p-${n}-${i}`, 19, 72));

    const { rerender } = render(googleElement({ markers: spot(7) }));
    const circle = await waitFor(() => document.querySelector('.dpg-cluster-count') as HTMLElement);
    expect(circle.textContent).toBe('7');
    expect(circle.style.width).toBe('38px');
    expect(recordsOf('AdvancedMarker').find((r) => r.props.title === '7')?.props.zIndex).toBe(1007);

    rerender(googleElement({ markers: spot(50) }));
    await waitFor(() =>
      expect((document.querySelector('.dpg-cluster-count') as HTMLElement).style.width).toBe('44px'),
    );
    rerender(googleElement({ markers: spot(200) }));
    await waitFor(() =>
      expect((document.querySelector('.dpg-cluster-count') as HTMLElement).style.width).toBe('50px'),
    );
  });

  it('adds one chip per domain to a multi-domain cluster bubble and none to a single-domain one', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { rerender } = render(
      googleElement({ markers: [at('s', 19, 72, 'seeker'), at('p', 19, 72, 'provider')] }),
    );
    const circle = await waitFor(() => document.querySelector('.dpg-cluster-count') as HTMLElement);
    const chips = circle.parentElement?.lastElementChild;
    expect(circle.parentElement?.children).toHaveLength(2);
    expect(chips?.children).toHaveLength(2);
    expect(chips?.textContent).toContain('1');

    rerender(googleElement({ markers: [at('s1', 19, 72, 'seeker'), at('s2', 19, 72, 'seeker')] }));
    await waitFor(() =>
      expect((document.querySelector('.dpg-cluster-count') as HTMLElement).parentElement?.children).toHaveLength(1),
    );
  });

  it.each([12, 21])('opens the same-spot card instead of zooming at zoom %i', async (zoom) => {
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom });
    bridge().gmap = gmap;
    render(googleElement({ markers: [at('a', 19.25, 72.25), at('b', 19.25, 72.25), at('c', 19.25, 72.25)] }));

    await userEvent.click(await screen.findByRole('button', { name: '3' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getByTestId('info-window')).toBeInTheDocument();
    expect(screen.getByText('3 listings at this exact spot')).toBeInTheDocument();
    expect(gmap.moveCamera).not.toHaveBeenCalled();
  });

  it('hands a same-spot bubble to the page when the provider draws no popups', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap({ zoom: 12 });
    const onSpotGroupSelect = vi.fn();
    render(
      googleElement({
        markers: [at('a', 19.25, 72.25), at('b', 19.25, 72.25)],
        showPopup: false,
        onSpotGroupSelect,
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: '2' }));

    expect(onSpotGroupSelect).toHaveBeenCalledWith(expect.objectContaining({ count: 2, exact: true }));
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('fills the same-spot card from renderSpotGroup and closes it on an empty-map click', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap({ zoom: 12 });
    render(
      googleElement({
        markers: [at('a', 19.25, 72.25), at('b', 19.25, 72.25)],
        renderSpotGroup: (group) => <p>custom {group.count}</p>,
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: '2' }));
    expect(screen.getByText('custom 2')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('google-map'));
    expect(screen.queryByText('custom 2')).not.toBeInTheDocument();
  });

  it('zooms a bubble click to the zoom where it splits', async () => {
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom: 12 });
    bridge().gmap = gmap;
    const lngPerPx = 360 / (256 * 2 ** 12);
    render(googleElement({ markers: [at('a', 19.25, 72.25), at('b', 19.25, 72.25 + 60 * lngPerPx)] }));

    await userEvent.click(await screen.findByRole('button', { name: '2' }));

    await waitFor(
      () => expect(gmap.moveCamera.mock.calls.at(-1)?.[0].zoom).toBeCloseTo(13, 5),
      { timeout: 4500 },
    );
  });

  it('draws a listing on the viewer\'s own location above the "You are here" marker', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [at('mine', 19, 72.5)], selfLocation: { lat: 19, lng: 72.5 } }));

    await screen.findByRole('button', { name: 'mine' });
    const pin = recordsOf('AdvancedMarker').find((r) => r.props.title === 'mine')?.props ?? {};
    const self = recordsOf('AdvancedMarker').find((r) => r.props.clickable === false)?.props ?? {};
    expect(Number(pin.zIndex)).toBeGreaterThan(Number(self.zIndex));
  });

  it('preserves the live camera across the light/dark remount of the map', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom: 9 });
    gmap.camera.lat = 30;
    gmap.camera.lng = 40;
    bridge().gmap = gmap;
    const { rerender } = render(googleElement());

    // The camera tracker records wherever the user has panned to.
    act(() => gmap.fire('idle'));

    bridge().themeMode = 'dark';
    rerender(googleElement());

    const props = lastProps('GMap');
    expect(props.colorScheme).toBe('DARK');
    expect(props.defaultCenter).toEqual({ lat: 30, lng: 40 });
    expect(props.defaultZoom).toBe(9);
  });

  it('nudges the map so an expanding popup card stays fully visible', async () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;
    render(googleElement({ markers: [ALPHA] }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    const observer = resizeObservers.at(-1);
    const node = observer?.node as HTMLElement;
    expect(node).toBeTruthy();

    stubRect(gmap.div, { top: 0, bottom: 500, height: 500 });
    const cardRect = stubRect(node, { top: -50, bottom: 250, height: 300 });

    // First measurement is only the baseline — Google's own open-time auto-pan
    // must not be fought.
    observer?.callback();
    expect(gmap.panBy).not.toHaveBeenCalled();

    // The card grows (e.g. "View more details") → pan to reveal its clipped top.
    cardRect.height = 420;
    observer?.callback();

    await waitFor(() => expect(gmap.panBy).toHaveBeenCalledWith(0, -66));
  });
});
