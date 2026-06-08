import { getRuntimeEnv } from '@/lib/runtime-env';
import type { GeoProvider } from './types';
import { createPhotonProvider } from './photon';
import { createGooglePlacesProvider } from './google-places';

let cached: GeoProvider | null = null;

/**
 * Active geo provider: Google Places when a maps key is configured, otherwise
 * the key-less Photon fallback.
 */
export function getGeoProvider(): GeoProvider {
  if (cached) return cached;
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');
  const photonUrl = getRuntimeEnv('VITE_PHOTON_URL') as string | undefined;
  cached = apiKey
    ? createGooglePlacesProvider(apiKey)
    : createPhotonProvider(photonUrl || undefined);
  return cached;
}
