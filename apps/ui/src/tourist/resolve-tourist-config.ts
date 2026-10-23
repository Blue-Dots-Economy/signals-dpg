/**
 * Resolves the active (networkId, brandSlug) pair for the tourist app.
 *
 * Network order (as in index.tourist.html's inline script and
 * NetworkThemeProvider): ?network= → window.__DPG_UI_CONFIG__.VITE_NETWORK_NAME
 * → the first entry of build-time VITE_NETWORK_ID → 'orange_dot'.
 *
 * Brand comes from resolveBrand() (runtime config → build default →
 * 'standard'). There is no ?brand= param: brand is per-deployment.
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
  // VITE_NETWORK_ID may be a comma-separated list; the tourist app uses the first.
  const envNet = (import.meta.env.VITE_NETWORK_ID ?? '').split(',')[0].trim();
  return envNet || 'orange_dot';
}

function resolveTouristBrand(): string {
  const rt =
    typeof window !== 'undefined'
      ? (window as Window).__DPG_UI_CONFIG__?.VITE_BRAND_NAME
      : null;
  const buildDefault =
    typeof __DEFAULT_BRAND__ !== 'undefined' ? __DEFAULT_BRAND__ : null;
  return resolveBrand({ runtimeConfig: rt ?? null, buildDefault });
}

export const TOURIST_NETWORK_ID: string = resolveTouristNetwork();
export const TOURIST_BRAND: string = resolveTouristBrand();
