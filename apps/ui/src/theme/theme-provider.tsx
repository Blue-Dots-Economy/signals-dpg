import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { resolveTheme, type NetworkTheme } from './network-themes';
import { resolveBrand } from './resolve-brand';
import { resolveBrandMeta, type BrandMeta } from './brand-meta';
import { getServedScope } from '@/lib/served-binding';
import { clearSchemaCache } from '@/engine';

interface NetworkThemeContextValue {
  themeId: string;
  theme: NetworkTheme;
  brand: string;
}

const NetworkThemeContext = React.createContext<NetworkThemeContextValue>({
  themeId: 'blue_dot',
  theme: resolveTheme('blue_dot'),
  brand: 'standard',
});

export function useNetworkTheme(): NetworkThemeContextValue {
  return React.useContext(NetworkThemeContext);
}

function getInitialNetworkId(): string {
  const url = new URLSearchParams(window.location.search).get('network');
  if (url) return url;
  // Runtime config (window.__DPG_UI_CONFIG__, from the chart's /config.js) wins
  // over the build-time default, so one image serves any network.
  const runtimeNet =
    typeof window !== 'undefined'
      ? (window as Window).__DPG_UI_CONFIG__?.VITE_NETWORK_NAME
      : undefined;
  if (runtimeNet) return runtimeNet;
  // __DEFAULT_NETWORK_THEME__ is injected by Vite define at build time
  const fromEnv =
    typeof __DEFAULT_NETWORK_THEME__ !== 'undefined' ? __DEFAULT_NETWORK_THEME__ : '';
  return fromEnv || 'blue_dot';
}

function kebab(id: string): string {
  return id.replaceAll('_', '-');
}

function applyFavicon(id: string, brand: string, meta: BrandMeta): void {
  // Drop any existing icons (PNG remnants etc.) before installing the new one.
  document
    .querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
    .forEach((el) => el.parentNode?.removeChild(el));

  const link = document.createElement('link');
  link.rel = 'icon';
  link.dataset.network = id;

  if (meta.faviconType === 'png') {
    // Designer-shipped square mark: /brand/<network>/<brand>/favicon.png for a
    // non-standard brand, else /brand/<network>/favicon.png.
    link.type = 'image/png';
    link.href =
      brand && brand !== 'standard'
        ? `/brand/${kebab(id)}/${brand}/favicon.png`
        : `/brand/${kebab(id)}/favicon.png`;
  } else {
    // brand.json logos are wide wordmarks, useless at 16×16, so generate a
    // square dot-mark SVG from the network's --brand-cta colour.
    const cssVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--brand-cta')
      .trim();
    const colour = cssVar || '#000000';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="6" fill="${colour}"/>
      <circle cx="16" cy="16" r="6" fill="white" opacity="0.95"/>
      <circle cx="10" cy="10" r="2.2" fill="white" opacity="0.6"/>
      <circle cx="23" cy="22" r="2" fill="white" opacity="0.55"/>
    </svg>`;
    link.type = 'image/svg+xml';
    link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  document.head.appendChild(link);
}

function applyDocumentTitle(theme: NetworkTheme, brandCopy: Record<string, string>): void {
  // Network brand + "Signal Stack". With exactly one served domain the domain
  // is included (e.g. "Purple Dot · Provider · Signal Stack"); otherwise the
  // plain network title. Brand copy wins when it sets a title.
  const networkName = brandCopy['title'] ?? theme.name;
  const scope = getServedScope();
  const domainLabel =
    scope && scope.domains.length === 1
      ? scope.domains[0].replaceAll('_', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase())
      : null;
  document.title = domainLabel
    ? `${networkName} · ${domainLabel} · Signal Stack`
    : `${networkName} · Signal Stack`;
}

/**
 * Applies the active network + brand to `<html>` (`data-network`/`data-brand`)
 * and installs the brand-aware favicon. Returns the resolved brand meta.
 * Exported for the tourist entry point: the inline HTML script only sets
 * first-paint fallbacks, because Vite `define` does not replace tokens
 * (`__DEFAULT_BRAND__`, `__BRAND_REGISTRY__`) inside classic inline scripts.
 */
export function applyNetworkBrand(id: string, brand: string): BrandMeta {
  const el = document.documentElement;
  el.dataset.network = id;
  el.dataset.brand = brand;
  // Tokens come from the brand-theme Vite plugin's <style> block selected by
  // [data-network][data-brand]. Force the selector to apply before
  // applyFavicon reads --brand-cta.
  void el.offsetWidth;
  const meta = resolveBrandMeta(id, brand);
  applyFavicon(id, brand, meta);
  return meta;
}

function applyThemeTokens(id: string, brand: string): void {
  const meta = applyNetworkBrand(id, brand);
  applyDocumentTitle(resolveTheme(id), meta.copy);
}

const ACTIVE_NETWORK_KEY = 'dpg-active-network';

export function NetworkThemeProvider({ children }: { children: React.ReactNode }) {
  const [searchParams] = useSearchParams();
  const networkFromUrl = searchParams.get('network');

  const themeId = React.useMemo(() => {
    // URL wins. Otherwise reuse the last network the user was on: routes like
    // /my-actions carry no ?network=, and the build default would flip the
    // theme mid-session.
    if (networkFromUrl) return networkFromUrl;
    // Runtime config wins over localStorage, so a fresh visitor lands on the
    // chart-configured brand.
    const runtimeNet =
      typeof window !== 'undefined'
        ? (window as Window).__DPG_UI_CONFIG__?.VITE_NETWORK_NAME
        : undefined;
    if (runtimeNet) return runtimeNet;
    let stored = '';
    try {
      stored = localStorage.getItem(ACTIVE_NETWORK_KEY) ?? '';
    } catch {
      /* localStorage unavailable */
    }
    // Honour a stored network only if this build serves it; a stale value
    // (e.g. after changing VITE_NETWORK_ID in local dev) is discarded.
    const configuredNetworks = (import.meta.env.VITE_NETWORK_ID ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (stored && (configuredNetworks.length === 0 || configuredNetworks.includes(stored))) {
      return stored;
    }
    if (stored) {
      try {
        localStorage.removeItem(ACTIVE_NETWORK_KEY);
      } catch {
        /* ignore */
      }
    }
    const fromEnv =
      typeof __DEFAULT_NETWORK_THEME__ !== 'undefined' ? __DEFAULT_NETWORK_THEME__ : '';
    return fromEnv || 'blue_dot';
  }, [networkFromUrl]);

  // Persist a network chosen via the URL so other routes keep its theme.
  React.useEffect(() => {
    if (!networkFromUrl) return;
    try {
      localStorage.setItem(ACTIVE_NETWORK_KEY, networkFromUrl);
    } catch {
      /* ignore */
    }
  }, [networkFromUrl]);

  const theme = React.useMemo(() => resolveTheme(themeId), [themeId]);

  const activeBrand = React.useMemo(
    () =>
      resolveBrand({
        runtimeConfig:
          typeof window !== 'undefined'
            ? (window as Window).__DPG_UI_CONFIG__?.VITE_BRAND_NAME
            : null,
        buildDefault: typeof __DEFAULT_BRAND__ !== 'undefined' ? __DEFAULT_BRAND__ : null,
      }),
    [],
  );

  React.useLayoutEffect(() => {
    applyThemeTokens(themeId, activeBrand);
  }, [themeId, activeBrand]);

  React.useEffect(() => {
    // Only a network switch (via URL) triggers this at runtime. Relies on
    // schema resolution being async, so this sync clear lands before any
    // post-await cache read.
    clearSchemaCache();
  }, [themeId, activeBrand]);

  const value = React.useMemo(
    () => ({ themeId, theme, brand: activeBrand }),
    [themeId, theme, activeBrand],
  );

  return (
    <NetworkThemeContext.Provider value={value}>{children}</NetworkThemeContext.Provider>
  );
}

// Exported for tests; index.html's inline script duplicates this precedence.
export { getInitialNetworkId };
