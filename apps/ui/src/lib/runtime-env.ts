/**
 * Reads a VITE_* key from runtime config first (`window.__DPG_UI_CONFIG__`,
 * written by the chart into /config.js at deploy time), then the build-time
 * `import.meta.env` value, so one UI image is reconfigurable per deployment.
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
