import { getRuntimeEnv } from '@/lib/runtime-env';
import type { GeoProvider } from './types';
import { createPhotonProvider } from './photon';
import { createGooglePlacesProvider } from './google-places';
import { looksLikePIIMask } from './pii-mask';
import { withGeoCache } from './geo-cache';

let cached: GeoProvider | null = null;

/**
 * `VITE_GEO_COUNTRY` → upper-case ISO 3166-1 alpha-2, or undefined (no
 * restriction) when unset, blank, or not a two-letter code (#785).
 */
export function normalizeCountry(raw: string | undefined): string | undefined {
  const v = raw?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? v : undefined;
}

/**
 * Active geo provider: Google Places when a maps key is configured, otherwise
 * the key-less Photon fallback.
 *
 * A PII-mask guard is applied centrally here so that form autocomplete skips
 * queries that are API-masked values (e.g. "***", "+91-XX-XXXX-X123").
 */
export function getGeoProvider(): GeoProvider {
  if (cached) return cached;
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');
  const photonUrl = getRuntimeEnv('VITE_PHOTON_URL') as string | undefined;
  const country = normalizeCountry(getRuntimeEnv('VITE_GEO_COUNTRY') as string | undefined);
  const base = withGeoCache(
    apiKey
      ? createGooglePlacesProvider(apiKey, country)
      : createPhotonProvider(photonUrl || undefined),
  );
  cached = {
    suggest: (query, signal) =>
      looksLikePIIMask(query) ? Promise.resolve([]) : base.suggest(query, signal),
  };
  return cached;
}
