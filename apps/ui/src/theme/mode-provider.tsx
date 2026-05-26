import * as React from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeModeContextValue {
  mode: ThemeMode;
  /** Resolved value — `'system'` collapses to `'light'` or `'dark'`. */
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'dpg-theme-mode';

const ThemeModeContext = React.createContext<ThemeModeContextValue>({
  mode: 'system',
  resolved: 'light',
  setMode: () => {},
});

export function useThemeMode(): ThemeModeContextValue {
  return React.useContext(ThemeModeContext);
}

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* localStorage may be disabled (private mode) — fall through */
  }
  // Default is light. Users opt into dark or system via the toggle.
  return 'light';
}

function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return mode;
}

function applyDocumentClass(resolved: 'light' | 'dark'): void {
  const el = document.documentElement;
  if (resolved === 'dark') el.classList.add('dark');
  else el.classList.remove('dark');
}

export function ThemeModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<ThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = React.useState<'light' | 'dark'>(() =>
    resolveMode(readStoredMode()),
  );

  // Apply class + persist whenever the selected mode changes.
  React.useLayoutEffect(() => {
    const r = resolveMode(mode);
    setResolved(r);
    applyDocumentClass(r);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  // Track the OS preference only while `system` is selected so the page
  // flips when the user changes their system theme without a reload.
  React.useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const r = mq.matches ? 'dark' : 'light';
      setResolved(r);
      applyDocumentClass(r);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const value = React.useMemo<ThemeModeContextValue>(
    () => ({ mode, resolved, setMode: setModeState }),
    [mode, resolved],
  );

  return (
    <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>
  );
}
