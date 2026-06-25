/**
 * Resolves the active brand slug, parallel to network resolution.
 * Order: query param → runtime config (window.__DPG_UI_CONFIG__) →
 * build-time default → 'standard'. 'standard' means no brand override
 * (the agnostic network theme).
 */
export function resolveBrand(opts: {
  queryParam?: string | null;
  runtimeConfig?: string | null;
  buildDefault?: string | null;
}): string {
  const pick = (v?: string | null) => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  return pick(opts.queryParam) ?? pick(opts.runtimeConfig) ?? pick(opts.buildDefault) ?? 'standard';
}
