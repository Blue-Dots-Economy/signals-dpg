import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { resolveTheme, type NetworkTheme } from './network-themes';

interface NetworkThemeContextValue {
  themeId: string;
  theme: NetworkTheme;
}

const NetworkThemeContext = React.createContext<NetworkThemeContextValue>({
  themeId: 'blue_dot',
  theme: resolveTheme('blue_dot'),
});

export function useNetworkTheme(): NetworkThemeContextValue {
  return React.useContext(NetworkThemeContext);
}

function getInitialNetworkId(): string {
  const url = new URLSearchParams(window.location.search).get('network');
  if (url) return url;
  // Runtime config (window.__DPG_UI_CONFIG__) is injected by the chart at
  // deploy time via /config.js (loaded in index.html before the bundle).
  // It wins over the Vite build-time default, so a single image can be
  // re-used across networks — the chart decides which brand renders.
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

function applyFavicon(id: string): void {
  // brand.json logos are wide wordmarks ("purple dots AI") — useless when
  // downscaled to the tab's 16×16 favicon slot. Generate a square dot-mark
  // SVG from the active network's --brand-cta CSS var so the tab actually
  // shows colour-matched branding for any number of networks.
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
  const href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  // Drop any existing icons (PNG remnants etc.) before installing the SVG one.
  document
    .querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
    .forEach((el) => el.parentNode?.removeChild(el));
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = href;
  link.dataset.network = id;
  document.head.appendChild(link);
}

function applyDocumentTitle(theme: NetworkTheme): void {
  // Network brand + "Signal Stack" platform name. Portal label varies per
  // network and was too generic for the tab; "Signal Stack" is the constant
  // product identity users learn to recognise across all dot deployments.
  document.title = `${theme.name} · Signal Stack`;
}

function applyThemeTokens(id: string): void {
  const theme = resolveTheme(id);
  const el = document.documentElement;
  el.dataset.network = id;
  // Tokens come from the brand-theme Vite plugin's static <style> block
  // selected by [data-network=<id>] — inline styles here would shadow
  // those with stale hardcoded values from network-themes.ts and stop
  // brand.json-derived colours (incl. --brand-cta) from updating on
  // network switch. Force the browser to apply the new selector before
  // applyFavicon reads --brand-cta.
  void el.offsetWidth;
  applyFavicon(id);
  applyDocumentTitle(theme);
}

const ACTIVE_NETWORK_KEY = 'dpg-active-network';

export function NetworkThemeProvider({ children }: { children: React.ReactNode }) {
  const [searchParams] = useSearchParams();
  const networkFromUrl = searchParams.get('network');

  const themeId = React.useMemo(() => {
    // URL wins. Otherwise reuse the last network the user was on (routes like
    // /my-actions carry no ?network=, and falling back to the build default
    // would flip the theme to the wrong brand mid-session).
    if (networkFromUrl) return networkFromUrl;
    // Runtime config (window.__DPG_UI_CONFIG__.VITE_NETWORK_NAME) — written
    // by the chart at deploy time. Must win over localStorage so a fresh
    // visitor lands on the chart-configured brand even without ?network=.
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
    if (stored) return stored;
    const fromEnv =
      typeof __DEFAULT_NETWORK_THEME__ !== 'undefined' ? __DEFAULT_NETWORK_THEME__ : '';
    return fromEnv || 'blue_dot';
  }, [networkFromUrl]);

  // Persist the network whenever it's explicitly chosen via the URL so other
  // routes inherit the same brand theme.
  React.useEffect(() => {
    if (!networkFromUrl) return;
    try {
      localStorage.setItem(ACTIVE_NETWORK_KEY, networkFromUrl);
    } catch {
      /* ignore */
    }
  }, [networkFromUrl]);

  const theme = React.useMemo(() => resolveTheme(themeId), [themeId]);

  React.useLayoutEffect(() => {
    applyThemeTokens(themeId);
  }, [themeId]);

  const value = React.useMemo(() => ({ themeId, theme }), [themeId, theme]);

  return (
    <NetworkThemeContext.Provider value={value}>{children}</NetworkThemeContext.Provider>
  );
}

// Standalone bootstrap — called by the pre-React inline script via a module
// import (for type safety in tests). The inline script calls the same logic.
export { getInitialNetworkId };
