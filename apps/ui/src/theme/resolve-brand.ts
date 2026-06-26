/**
 * Resolves the active brand slug from deployment config only.
 * Order: runtime config (window.__DPG_UI_CONFIG__) → build-time default →
 * 'standard'. 'standard' means no brand override (the agnostic network theme).
 *
 * The ?brand= query param was intentionally removed: brand is per-deployment
 * and must not be overridable by end-users via URL.
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
