import { getRuntimeEnv } from '@/lib/runtime-env';
import type { GeoProvider } from './types';
import { createPhotonProvider } from './photon';
import { createGooglePlacesProvider } from './google-places';
import { looksLikePIIMask } from './pii-mask';
import { withGeoCache } from './geo-cache';

let cached: GeoProvider | null = null;

/**
 * Active geo provider: Google Places when a maps key is configured, otherwise
 * the key-less Photon fallback.
 *
 * A PII-mask guard is applied centrally here so that both form autocomplete and
 * map fallback geocoding skip queries that are API-masked values (e.g. "***",
 * "+91-XX-XXXX-X123").
 */
export function getGeoProvider(): GeoProvider {
  if (cached) return cached;
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');
  const photonUrl = getRuntimeEnv('VITE_PHOTON_URL') as string | undefined;
  const base = withGeoCache(
    apiKey
      ? createGooglePlacesProvider(apiKey)
      : createPhotonProvider(photonUrl || undefined),
  );
  cached = {
    suggest: (query, signal) =>
      looksLikePIIMask(query) ? Promise.resolve([]) : base.suggest(query, signal),
    geocode: (address, signal) =>
      looksLikePIIMask(address) ? Promise.resolve(null) : base.geocode(address, signal),
  };
  return cached;
}
