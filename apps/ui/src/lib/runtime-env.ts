/**
 * Reads a VITE_* key from runtime config first (window.__DPG_UI_CONFIG__,
 * written by the chart into /config.js at deploy time), then falls back to
 * the build-time value baked in by Vite (import.meta.env). Lets a single
 * UI image be reconfigured per deployment without rebuilds.
 */
export function getRuntimeEnv<K extends keyof ImportMetaEnv>(
  key: K,
): ImportMetaEnv[K] | string | undefined {
  if (typeof window !== 'undefined') {
    const rt = (window as Window).__DPG_UI_CONFIG__ as
      | Record<string, string>
      | undefined;
    const v = rt?.[key as string];
    if (v !== undefined && v !== '') return v;
  }
  return import.meta.env[key];
}
