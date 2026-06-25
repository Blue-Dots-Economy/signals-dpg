/**
 * Resolves the active (networkId, brandSlug) pair for the tourist app.
 *
 * Network resolution order (mirrors index.tourist.html inline script and
 * NetworkThemeProvider for the portal app):
 *   1. ?network= query param
 *   2. window.__DPG_UI_CONFIG__.VITE_NETWORK_NAME  (chart runtime config)
 *   3. import.meta.env.VITE_NETWORK_ID.split(',')[0] (build-time env)
 *   4. 'orange_dot'  — overridable fallback for the default tourist deployment
 *
 * Brand resolution delegates to resolveBrand() (query → runtime config →
 * build default → 'standard').
 */
import { resolveBrand } from '@/theme/resolve-brand';

/** Resolved once at module-load time; stable for the page lifetime. */
function resolveTouristNetwork(): string {
  if (typeof window !== 'undefined') {
    const url = new URLSearchParams(window.location.search).get('network');
    if (url?.trim()) return url.trim();
    const rt = (window as Window).__DPG_UI_CONFIG__?.VITE_NETWORK_NAME;
    if (rt?.trim()) return rt.trim();
  }
  // Build-time env: VITE_NETWORK_ID may be a comma-separated list (e.g. for
  // multi-network portal builds). The tourist app uses the first entry.
  const envNet = (import.meta.env.VITE_NETWORK_ID ?? '').split(',')[0].trim();
  return envNet || 'orange_dot';
}

function resolveTouristBrand(): string {
  const params =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const rt =
    typeof window !== 'undefined'
      ? (window as Window).__DPG_UI_CONFIG__?.VITE_BRAND_NAME
      : null;
  const buildDefault =
    typeof __DEFAULT_BRAND__ !== 'undefined' ? __DEFAULT_BRAND__ : null;
  return resolveBrand({
    queryParam: params?.get('brand') ?? null,
    runtimeConfig: rt ?? null,
    buildDefault,
  });
}

export const TOURIST_NETWORK_ID: string = resolveTouristNetwork();
export const TOURIST_BRAND: string = resolveTouristBrand();
