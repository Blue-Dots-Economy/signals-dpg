import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import {
  NetworkThemeProvider,
  useNetworkTheme,
  applyNetworkBrand,
  getInitialNetworkId,
} from '../theme-provider';
import { ThemeModeProvider, useThemeMode } from '../mode-provider';
import { getCachedSchema, setCachedSchema, clearSchemaCache } from '@/engine';

const ACTIVE_NETWORK_KEY = 'dpg-active-network';
const MODE_KEY = 'dpg-theme-mode';

/**
 * Build-time Vite `define` globals. They are genuinely absent under vitest
 * (no `define` in vitest.config.ts), which is what makes the
 * `typeof X !== 'undefined'` guards in the providers reachable both ways.
 */
const buildGlobals = globalThis as unknown as {
  __DEFAULT_NETWORK_THEME__?: string;
  __DEFAULT_BRAND__?: string;
  __BRAND_REGISTRY__?: typeof __BRAND_REGISTRY__;
};

function setRuntimeConfig(config: Record<string, string> | undefined): void {
  const host = window as unknown as { __DPG_UI_CONFIG__?: Record<string, string> };
  if (config === undefined) delete host.__DPG_UI_CONFIG__;
  else host.__DPG_UI_CONFIG__ = config;
}

function iconLinks(): HTMLLinkElement[] {
  return Array.from(
    document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]'),
  );
}

function resetDom(): void {
  const el = document.documentElement;
  delete el.dataset.network;
  delete el.dataset.brand;
  el.classList.remove('dark');
  el.removeAttribute('style');
  iconLinks().forEach((l) => l.remove());
  document.title = '';
}

/**
 * Swap the `localStorage` global for one whose `getItem`/`setItem` throws, so
 * the providers' "storage unavailable" branches are reachable.
 *
 * Deliberately NOT `vi.spyOn(globalThis.localStorage, …)`: happy-dom 20's
 * Storage is Proxy-backed, so a spy installed on it is not undone by
 * `vi.restoreAllMocks()` and leaks into every later test in this file (the
 * throw then surfaces from an unrelated assertion). `vi.stubGlobal` replaces
 * the binding outright and `vi.unstubAllGlobals()` in afterEach puts the real
 * Storage back. Every other method still delegates to the real storage so a
 * test can keep asserting on what was written.
 */
function breakStorage(method: 'getItem' | 'setItem', message: string): void {
  const real = globalThis.localStorage;
  const boom = (): never => {
    throw new Error(message);
  };
  vi.stubGlobal('localStorage', {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (index: number) => real.key(index),
    removeItem: (key: string) => real.removeItem(key),
    getItem: method === 'getItem' ? boom : (key: string) => real.getItem(key),
    setItem:
      method === 'setItem' ? boom : (key: string, value: string) => real.setItem(key, value),
  } satisfies Storage);
}

beforeEach(() => {
  localStorage.clear();
  setRuntimeConfig(undefined);
  delete buildGlobals.__DEFAULT_NETWORK_THEME__;
  delete buildGlobals.__DEFAULT_BRAND__;
  delete buildGlobals.__BRAND_REGISTRY__;
  window.history.replaceState({}, '', '/');
  resetDom();
  clearSchemaCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRuntimeConfig(undefined);
  delete buildGlobals.__DEFAULT_NETWORK_THEME__;
  delete buildGlobals.__DEFAULT_BRAND__;
  delete buildGlobals.__BRAND_REGISTRY__;
  resetDom();
});

// ---------------------------------------------------------------------------
// getInitialNetworkId — the pre-React bootstrap precedence chain
// ---------------------------------------------------------------------------

describe('getInitialNetworkId precedence', () => {
  it('?network= query param wins over runtime config and the build default', () => {
    window.history.replaceState({}, '', '/?network=purple_dot');
    setRuntimeConfig({ VITE_NETWORK_NAME: 'green_dot' });
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'yellow_dot';
    expect(getInitialNetworkId()).toBe('purple_dot');
  });

  it('runtime config wins over the build default when no query param', () => {
    setRuntimeConfig({ VITE_NETWORK_NAME: 'green_dot' });
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'yellow_dot';
    expect(getInitialNetworkId()).toBe('green_dot');
  });

  it('build-time default is used when neither query param nor runtime config is set', () => {
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'yellow_dot';
    expect(getInitialNetworkId()).toBe('yellow_dot');
  });

  it('falls back to blue_dot when nothing is configured', () => {
    expect(getInitialNetworkId()).toBe('blue_dot');
  });

  it('falls back to blue_dot when the build default is defined but empty', () => {
    buildGlobals.__DEFAULT_NETWORK_THEME__ = '';
    expect(getInitialNetworkId()).toBe('blue_dot');
  });
});

// ---------------------------------------------------------------------------
// applyNetworkBrand — <html> data attributes + favicon install
// ---------------------------------------------------------------------------

describe('applyNetworkBrand', () => {
  it('marks <html> with the active network and brand', () => {
    applyNetworkBrand('purple_dot', 'onetac');
    expect(document.documentElement.dataset.network).toBe('purple_dot');
    expect(document.documentElement.dataset.brand).toBe('onetac');
  });

  it('installs a single generated svg dot-mark favicon tagged with the network', () => {
    applyNetworkBrand('green_dot', 'standard');
    const links = iconLinks();
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe('image/svg+xml');
    expect(links[0].dataset.network).toBe('green_dot');
    expect(links[0].getAttribute('href')).toContain('data:image/svg+xml;utf8,');
    expect(decodeURIComponent(links[0].getAttribute('href') ?? '')).toContain('<svg');
  });

  it('drops pre-existing icon links (including shortcut icon remnants)', () => {
    const stale = document.createElement('link');
    stale.rel = 'icon';
    stale.href = '/stale.png';
    const staleShortcut = document.createElement('link');
    staleShortcut.rel = 'shortcut icon';
    staleShortcut.href = '/stale-shortcut.ico';
    document.head.append(stale, staleShortcut);

    applyNetworkBrand('blue_dot', 'standard');

    const links = iconLinks();
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).not.toContain('stale');
  });

  it('falls back to a black dot-mark when --brand-cta is not resolvable', () => {
    applyNetworkBrand('blue_dot', 'standard');
    // encodeURIComponent('#000000') === '%23000000'
    expect(iconLinks()[0].getAttribute('href')).toContain('%23000000');
  });

  it('colours the generated dot-mark from the resolved --brand-cta custom property', () => {
    document.documentElement.style.setProperty('--brand-cta', '#ff0000');
    applyNetworkBrand('blue_dot', 'standard');
    const href = decodeURIComponent(iconLinks()[0].getAttribute('href') ?? '');
    expect(href).toContain('fill="#ff0000"');
  });

  it('uses the brand-scoped png path when the registry declares a png favicon', () => {
    buildGlobals.__BRAND_REGISTRY__ = {
      blue_dot: {
        faviconType: 'svg',
        logoShape: 'wordmark',
        brands: { upsdm: { faviconType: 'png', logoShape: 'square' } },
      },
    };
    const meta = applyNetworkBrand('blue_dot', 'upsdm');
    const link = iconLinks()[0];
    expect(link.type).toBe('image/png');
    expect(link.getAttribute('href')).toBe('/brand/blue-dot/upsdm/favicon.png');
    expect(meta).toEqual({
      faviconType: 'png',
      logoShape: 'square',
      copy: {},
      footerLogo: null,
      footerLogoLight: null,
    });
  });

  it('uses the network-level png path (no brand segment) for the standard brand', () => {
    buildGlobals.__BRAND_REGISTRY__ = {
      purple_dot: { faviconType: 'png' },
    };
    applyNetworkBrand('purple_dot', 'standard');
    // network id is kebab-cased in asset paths
    expect(iconLinks()[0].getAttribute('href')).toBe('/brand/purple-dot/favicon.png');
  });

  it('returns the merged brand meta copy (brand override over network base)', () => {
    buildGlobals.__BRAND_REGISTRY__ = {
      blue_dot: {
        copy: { title: 'Blue Dots', tagline: 'network base' },
        brands: { upsdm: { copy: { title: 'UPSDM' } } },
      },
    };
    expect(applyNetworkBrand('blue_dot', 'upsdm')).toEqual({
      faviconType: 'svg',
      logoShape: 'wordmark',
      copy: { title: 'UPSDM', tagline: 'network base' },
      footerLogo: null,
      footerLogoLight: null,
    });
  });
});

// ---------------------------------------------------------------------------
// NetworkThemeProvider
// ---------------------------------------------------------------------------

function ThemeProbe() {
  const { themeId, theme, brand } = useNetworkTheme();
  const [, setSearchParams] = useSearchParams();
  return (
    <div>
      <p>{`id:${themeId}`}</p>
      <p>{`name:${theme.name}`}</p>
      <p>{`brand:${brand}`}</p>
      <button onClick={() => setSearchParams({ network: 'green_dot' })}>Switch network</button>
    </div>
  );
}

function renderTheme(entry = '/') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <NetworkThemeProvider>
        <ThemeProbe />
      </NetworkThemeProvider>
    </MemoryRouter>,
  );
}

describe('NetworkThemeProvider network resolution', () => {
  it('?network= wins over runtime config, stored network and build default', () => {
    setRuntimeConfig({ VITE_NETWORK_NAME: 'green_dot' });
    localStorage.setItem(ACTIVE_NETWORK_KEY, 'yellow_dot');
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'pink_dot';

    renderTheme('/?network=purple_dot');

    expect(screen.getByText('id:purple_dot')).toBeInTheDocument();
    expect(screen.getByText('name:Purple Dot')).toBeInTheDocument();
    expect(document.documentElement.dataset.network).toBe('purple_dot');
  });

  it('persists an explicitly chosen network so other routes inherit the brand', () => {
    renderTheme('/?network=purple_dot');
    expect(localStorage.getItem(ACTIVE_NETWORK_KEY)).toBe('purple_dot');
  });

  it('does not overwrite the stored network when the route carries no ?network=', () => {
    localStorage.setItem(ACTIVE_NETWORK_KEY, 'yellow_dot');
    renderTheme('/my-actions');
    expect(screen.getByText('id:yellow_dot')).toBeInTheDocument();
    expect(localStorage.getItem(ACTIVE_NETWORK_KEY)).toBe('yellow_dot');
  });

  it('runtime config wins over the stored network and the build default', () => {
    setRuntimeConfig({ VITE_NETWORK_NAME: 'purple_dot' });
    localStorage.setItem(ACTIVE_NETWORK_KEY, 'yellow_dot');
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'pink_dot';

    renderTheme('/');

    expect(screen.getByText('id:purple_dot')).toBeInTheDocument();
    expect(screen.getByText('name:Purple Dot')).toBeInTheDocument();
  });

  it('stored network wins over the build default', () => {
    localStorage.setItem(ACTIVE_NETWORK_KEY, 'green_dot');
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'pink_dot';

    renderTheme('/');

    expect(screen.getByText('id:green_dot')).toBeInTheDocument();
    expect(screen.getByText('name:Green Dot')).toBeInTheDocument();
  });

  it('keeps a stored network that this build is configured to serve', () => {
    vi.stubEnv('VITE_NETWORK_ID', ' purple_dot , green_dot ');
    localStorage.setItem(ACTIVE_NETWORK_KEY, 'green_dot');
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'purple_dot';

    renderTheme('/');

    expect(screen.getByText('id:green_dot')).toBeInTheDocument();
    expect(localStorage.getItem(ACTIVE_NETWORK_KEY)).toBe('green_dot');
  });

  it('discards (and clears) a stored network this build no longer serves', () => {
    vi.stubEnv('VITE_NETWORK_ID', 'purple_dot');
    localStorage.setItem(ACTIVE_NETWORK_KEY, 'green_dot');
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'yellow_dot';

    renderTheme('/');

    expect(screen.getByText('id:yellow_dot')).toBeInTheDocument();
    expect(localStorage.getItem(ACTIVE_NETWORK_KEY)).toBeNull();
  });

  it('falls back to blue_dot when nothing at all is configured', () => {
    renderTheme('/');
    expect(screen.getByText('id:blue_dot')).toBeInTheDocument();
    expect(screen.getByText('name:Blue Dots')).toBeInTheDocument();
  });

  it('survives an unreadable localStorage and still applies a theme', () => {
    breakStorage('getItem', 'storage disabled');
    buildGlobals.__DEFAULT_NETWORK_THEME__ = 'pink_dot';

    renderTheme('/');

    expect(screen.getByText('id:pink_dot')).toBeInTheDocument();
  });

  it('survives an unwritable localStorage when a network is chosen via URL', () => {
    breakStorage('setItem', 'quota exceeded');

    renderTheme('/?network=purple_dot');

    expect(screen.getByText('id:purple_dot')).toBeInTheDocument();
  });

  it('keeps an unknown network id as the active id but falls back to the blue_dot palette', () => {
    renderTheme('/?network=ghost_dot');
    expect(screen.getByText('id:ghost_dot')).toBeInTheDocument();
    expect(screen.getByText('name:Blue Dots')).toBeInTheDocument();
    expect(document.documentElement.dataset.network).toBe('ghost_dot');
  });

  it('re-themes, re-persists and re-clears the schema cache when the network switches at runtime', () => {
    renderTheme('/?network=purple_dot');
    expect(screen.getByText('name:Purple Dot')).toBeInTheDocument();

    setCachedSchema('https://example.test/network.json', { type: 'object' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));

    expect(screen.getByText('id:green_dot')).toBeInTheDocument();
    expect(screen.getByText('name:Green Dot')).toBeInTheDocument();
    expect(document.documentElement.dataset.network).toBe('green_dot');
    expect(localStorage.getItem(ACTIVE_NETWORK_KEY)).toBe('green_dot');
    expect(getCachedSchema('https://example.test/network.json')).toBeUndefined();
  });

  it('clears the schema cache on mount so a network switch cannot serve stale schemas', () => {
    setCachedSchema('https://example.test/network.json', { type: 'object' });
    expect(getCachedSchema('https://example.test/network.json')).toBeDefined();

    renderTheme('/?network=purple_dot');

    expect(getCachedSchema('https://example.test/network.json')).toBeUndefined();
  });

  it('exposes blue_dot/standard defaults to consumers rendered outside the provider', () => {
    function BareProbe() {
      const { themeId, theme, brand } = useNetworkTheme();
      return <p>{`${themeId}|${theme.name}|${brand}`}</p>;
    }
    render(<BareProbe />);
    expect(screen.getByText('blue_dot|Blue Dots|standard')).toBeInTheDocument();
  });
});

describe('NetworkThemeProvider brand resolution', () => {
  it('runtime config brand wins over the build-time default brand', () => {
    setRuntimeConfig({ VITE_BRAND_NAME: 'onetac' });
    buildGlobals.__DEFAULT_BRAND__ = 'upsdm';

    renderTheme('/');

    expect(screen.getByText('brand:onetac')).toBeInTheDocument();
    expect(document.documentElement.dataset.brand).toBe('onetac');
  });

  it('uses the build-time default brand when runtime config has none', () => {
    buildGlobals.__DEFAULT_BRAND__ = 'upsdm';

    renderTheme('/');

    expect(screen.getByText('brand:upsdm')).toBeInTheDocument();
    expect(document.documentElement.dataset.brand).toBe('upsdm');
  });

  it('falls back to the standard (no-override) brand', () => {
    renderTheme('/');
    expect(screen.getByText('brand:standard')).toBeInTheDocument();
    expect(document.documentElement.dataset.brand).toBe('standard');
  });

  it('ignores the ?brand= query param — brand is per-deployment, not user-selectable', () => {
    buildGlobals.__DEFAULT_BRAND__ = 'upsdm';
    renderTheme('/?brand=onetac&network=purple_dot');
    expect(screen.getByText('brand:upsdm')).toBeInTheDocument();
  });

  it('installs the brand-aware favicon for the active network on mount', () => {
    buildGlobals.__BRAND_REGISTRY__ = {
      purple_dot: { brands: { onetac: { faviconType: 'png' } } },
    };
    setRuntimeConfig({ VITE_BRAND_NAME: 'onetac' });

    renderTheme('/?network=purple_dot');

    expect(iconLinks()[0].getAttribute('href')).toBe('/brand/purple-dot/onetac/favicon.png');
  });
});

describe('NetworkThemeProvider document title', () => {
  it('uses "<network> · Signal Stack" when no served binding is configured', () => {
    renderTheme('/?network=purple_dot');
    expect(document.title).toBe('Purple Dot · Signal Stack');
  });

  it.each([
    {
      name: 'weaves in the domain for a single-domain deployment, title-casing it',
      binding: 'purple_dot/service_provider',
      expected: 'Purple Dot · Service Provider · Signal Stack',
    },
    {
      name: 'omits the domain when the deployment serves several domains',
      binding: 'purple_dot/provider,purple_dot/seeker',
      expected: 'Purple Dot · Signal Stack',
    },
    {
      name: 'omits the domain when the served binding is malformed',
      binding: 'purple_dot',
      expected: 'Purple Dot · Signal Stack',
    },
  ])('$name', ({ binding, expected }) => {
    setRuntimeConfig({ VITE_SERVED_BINDINGS: binding });
    renderTheme('/?network=purple_dot');
    expect(document.title).toBe(expected);
  });

  it('brand copy title wins over the network theme name', () => {
    buildGlobals.__BRAND_REGISTRY__ = {
      purple_dot: {
        copy: { title: 'Purple Dot' },
        brands: { onetac: { copy: { title: 'Onetac' } } },
      },
    };
    setRuntimeConfig({ VITE_BRAND_NAME: 'onetac' });

    renderTheme('/?network=purple_dot');

    expect(document.title).toBe('Onetac · Signal Stack');
  });
});

// ---------------------------------------------------------------------------
// ThemeModeProvider
// ---------------------------------------------------------------------------

type MqHandler = (event: MediaQueryListEvent) => void;

interface FakeMatchMedia {
  setDark: (dark: boolean) => void;
  listenerCount: () => number;
  queries: string[];
}

function installMatchMedia(initialDark: boolean): FakeMatchMedia {
  let dark = initialDark;
  const handlers = new Set<MqHandler>();
  const queries: string[] = [];
  const mq = {
    get matches() {
      return dark;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, handler: MqHandler) => {
      handlers.add(handler);
    },
    removeEventListener: (_type: string, handler: MqHandler) => {
      handlers.delete(handler);
    },
  };
  const impl = (query: string) => {
    queries.push(query);
    return mq;
  };
  vi.stubGlobal('matchMedia', impl);
  window.matchMedia = impl as unknown as typeof window.matchMedia;
  return {
    setDark: (next: boolean) => {
      dark = next;
      handlers.forEach((handler) => handler({ matches: dark } as MediaQueryListEvent));
    },
    listenerCount: () => handlers.size,
    queries,
  };
}

function ModeProbe() {
  const { mode, resolved, setMode } = useThemeMode();
  return (
    <div>
      <p>{`mode:${mode}`}</p>
      <p>{`resolved:${resolved}`}</p>
      <button onClick={() => setMode('dark')}>Dark</button>
      <button onClick={() => setMode('light')}>Light</button>
      <button onClick={() => setMode('system')}>System</button>
    </div>
  );
}

function renderMode() {
  return render(
    <ThemeModeProvider>
      <ModeProbe />
    </ThemeModeProvider>,
  );
}

function isDarkDocument(): boolean {
  return document.documentElement.classList.contains('dark');
}

describe('ThemeModeProvider', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
  });

  it('defaults to system and resolves dark from the OS preference', () => {
    const mm = installMatchMedia(true);

    renderMode();

    expect(screen.getByText('mode:system')).toBeInTheDocument();
    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(true);
    expect(mm.queries).toContain('(prefers-color-scheme: dark)');
  });

  it('defaults to system and resolves light when the OS prefers light', () => {
    installMatchMedia(false);

    renderMode();

    expect(screen.getByText('resolved:light')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(false);
  });

  it('persists the active mode so a reload keeps it', () => {
    installMatchMedia(false);
    renderMode();
    expect(localStorage.getItem(MODE_KEY)).toBe('system');
  });

  it('honours a stored dark pin even when the OS prefers light', () => {
    installMatchMedia(false);
    localStorage.setItem(MODE_KEY, 'dark');

    renderMode();

    expect(screen.getByText('mode:dark')).toBeInTheDocument();
    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(true);
  });

  it('honours a stored light pin even when the OS prefers dark', () => {
    installMatchMedia(true);
    localStorage.setItem(MODE_KEY, 'light');

    renderMode();

    expect(screen.getByText('mode:light')).toBeInTheDocument();
    expect(screen.getByText('resolved:light')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(false);
  });

  it('ignores a corrupt stored value and falls back to system', () => {
    installMatchMedia(true);
    localStorage.setItem(MODE_KEY, 'neon');

    renderMode();

    expect(screen.getByText('mode:system')).toBeInTheDocument();
    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
  });

  it('falls back to system when localStorage cannot be read', () => {
    installMatchMedia(true);
    breakStorage('getItem', 'storage disabled');

    renderMode();

    expect(screen.getByText('mode:system')).toBeInTheDocument();
    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(true);
  });

  it('still applies the theme class when localStorage cannot be written', () => {
    installMatchMedia(false);
    breakStorage('setItem', 'quota exceeded');

    renderMode();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(true);
  });

  it('pinning dark adds the dark class and persists the choice', () => {
    installMatchMedia(false);
    renderMode();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(screen.getByText('mode:dark')).toBeInTheDocument();
    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(true);
    expect(localStorage.getItem(MODE_KEY)).toBe('dark');
  });

  it('pinning light removes the dark class again', () => {
    installMatchMedia(true);
    renderMode();
    expect(isDarkDocument()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));

    expect(screen.getByText('resolved:light')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(false);
    expect(localStorage.getItem(MODE_KEY)).toBe('light');
  });

  it('follows a live OS colour-scheme change while system is selected', () => {
    const mm = installMatchMedia(false);
    renderMode();
    expect(isDarkDocument()).toBe(false);

    act(() => mm.setDark(true));

    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(true);

    act(() => mm.setDark(false));

    expect(screen.getByText('resolved:light')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(false);
  });

  it('stops following the OS once a mode is pinned explicitly', () => {
    const mm = installMatchMedia(false);
    renderMode();
    expect(mm.listenerCount()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(mm.listenerCount()).toBe(0);

    act(() => mm.setDark(true));

    expect(screen.getByText('resolved:light')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(false);
  });

  it('re-subscribes to the OS preference when system is selected again', () => {
    const mm = installMatchMedia(false);
    renderMode();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(mm.listenerCount()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(mm.listenerCount()).toBe(1);

    act(() => mm.setDark(true));
    expect(screen.getByText('resolved:dark')).toBeInTheDocument();
  });

  it('removes the OS preference listener on unmount', () => {
    const mm = installMatchMedia(false);
    const view = renderMode();
    expect(mm.listenerCount()).toBe(1);

    view.unmount();

    expect(mm.listenerCount()).toBe(0);
  });

  it('gives consumers outside the provider a light system default with an inert setter', () => {
    installMatchMedia(true);
    render(<ModeProbe />);

    expect(screen.getByText('mode:system')).toBeInTheDocument();
    expect(screen.getByText('resolved:light')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(screen.getByText('mode:system')).toBeInTheDocument();
    expect(isDarkDocument()).toBe(false);
  });
});
