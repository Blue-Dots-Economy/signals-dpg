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
  // __DEFAULT_NETWORK_THEME__ is injected by Vite define at build time
  const fromEnv =
    typeof __DEFAULT_NETWORK_THEME__ !== 'undefined' ? __DEFAULT_NETWORK_THEME__ : '';
  return fromEnv || 'blue_dot';
}

function applyThemeTokens(id: string): void {
  const theme = resolveTheme(id);
  const el = document.documentElement;
  el.dataset.network = id;
  for (const [key, value] of Object.entries(theme.tokens)) {
    el.style.setProperty(key, value);
  }
}

export function NetworkThemeProvider({ children }: { children: React.ReactNode }) {
  const [searchParams] = useSearchParams();
  const networkFromUrl = searchParams.get('network');

  const themeId = React.useMemo(() => {
    if (networkFromUrl) return networkFromUrl;
    const fromEnv =
      typeof __DEFAULT_NETWORK_THEME__ !== 'undefined' ? __DEFAULT_NETWORK_THEME__ : '';
    return fromEnv || 'blue_dot';
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
