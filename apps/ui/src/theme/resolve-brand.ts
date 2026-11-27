/**
 * Resolves the active brand slug from deployment config only: runtime config
 * (window.__DPG_UI_CONFIG__) → build-time default → 'standard' (no brand
 * override). There is no ?brand= param: brand is per-deployment and must not
 * be overridable by end users.
 */
export function resolveBrand(opts: {
  runtimeConfig?: string | null;
  buildDefault?: string | null;
}): string {
  const pick = (v?: string | null) => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  return pick(opts.runtimeConfig) ?? pick(opts.buildDefault) ?? 'standard';
}
