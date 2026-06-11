import { geocodingConfig } from '@/config';

export interface Coordinates {
  lat: number;
  lng: number;
}

/** Pure: first valid Photon feature -> coords. Exported for testing. */
export function parsePhotonFeatures(json: unknown): Coordinates | null {
  const features =
    (json as { features?: Array<{ geometry?: { coordinates?: [number, number] } }> })
      ?.features ?? [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (coords && coords.length === 2) {
      const [lng, lat] = coords;
      if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
    }
  }
  return null;
}

/** Pure: first Google geocode result -> coords. Exported for testing. */
export function parseGoogleGeocode(json: unknown): Coordinates | null {
  const data = json as {
    status?: string;
    results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
  };
  if (data?.status !== 'OK') return null;
  const loc = data.results?.[0]?.geometry?.location;
  if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    return { lat: loc.lat, lng: loc.lng };
  }
  return null;
}

/** A geocode result enriched with the administrative components we coarsen to. */
export interface GeoDetail extends Coordinates {
  city?: string;
  state?: string;
  country?: string;
}

/** Pure: first Google geocode result -> coords + city/state/country. Exported for testing. */
export function parseGoogleGeocodeDetailed(json: unknown): GeoDetail | null {
  const data = json as {
    status?: string;
    results?: Array<{
      geometry?: { location?: { lat: number; lng: number } };
      address_components?: Array<{ long_name: string; types: string[] }>;
    }>;
  };
  if (data?.status !== 'OK') return null;
  const result = data.results?.[0];
  const loc = result?.geometry?.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
  const comps = result?.address_components ?? [];
  const find = (types: string[]): string | undefined =>
    comps.find((c) => types.some((t) => c.types.includes(t)))?.long_name;
  return {
    lat: loc.lat,
    lng: loc.lng,
    // Prefer the proper city (locality); fall back to a UK-style post town, then
    // the district (admin_area_level_2) so even rural addresses resolve to a town.
    city: find(['locality']) ?? find(['postal_town']) ?? find(['administrative_area_level_2']),
    state: find(['administrative_area_level_1']),
    country: find(['country']),
  };
}

interface PhotonProps {
  city?: string;
  county?: string;
  district?: string;
  state?: string;
  country?: string;
}

/** Pure: first Photon feature -> coords + city/state/country. Exported for testing. */
export function parsePhotonFeaturesDetailed(json: unknown): GeoDetail | null {
  const features =
    (json as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: PhotonProps;
      }>;
    })?.features ?? [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (coords && coords.length === 2) {
      const [lng, lat] = coords;
      if (typeof lat === 'number' && typeof lng === 'number') {
        const p = f.properties ?? {};
        return { lat, lng, city: p.city ?? p.district ?? p.county, state: p.state, country: p.country };
      }
    }
  }
  return null;
}

async function resolveWithGoogle(query: string, apiKey: string): Promise<Coordinates | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', apiKey);
  const res = await fetch(url);
  if (!res.ok) return null;
  return parseGoogleGeocode(await res.json());
}

async function resolveWithPhoton(query: string, baseUrl: string): Promise<Coordinates | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return parsePhotonFeatures(await res.json());
}

async function resolveDetailed(query: string): Promise<GeoDetail | null> {
  if (geocodingConfig.google_api_key) {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('key', geocodingConfig.google_api_key);
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseGoogleGeocodeDetailed(await res.json());
  }
  const base = geocodingConfig.photon_url.replace(/\/$/, '');
  const res = await fetch(`${base}/api?q=${encodeURIComponent(query)}&limit=1`);
  if (!res.ok) return null;
  return parsePhotonFeaturesDetailed(await res.json());
}

function roundCoord(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Server-side resolve of a composite address string to coordinates.
 * Google Geocoding when a key is configured, else Photon. Returns null on any
 * failure — callers must treat geocoding as best-effort.
 */
export async function resolveCoordinates(query: string): Promise<Coordinates | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    if (geocodingConfig.google_api_key) {
      return await resolveWithGoogle(q, geocodingConfig.google_api_key);
    }
    return await resolveWithPhoton(q, geocodingConfig.photon_url);
  } catch {
    return null;
  }
}

/**
 * Resolves an address to a CITY-LEVEL coordinate for privacy-sensitive (PII)
 * fields: never returns the exact rooftop point. It geocodes the address, reads
 * the city/district from the result, then geocodes that city to its centroid.
 * If no city component is available (or the city geocode fails), it falls back
 * to the address coordinate rounded to ~1 km. Returns null only when the
 * address cannot be geocoded at all. Best-effort — callers handle null.
 */
export async function resolveCityCenter(address: string): Promise<Coordinates | null> {
  const q = address.trim();
  if (!q) return null;
  try {
    const detail = await resolveDetailed(q);
    if (!detail) return null;
    const cityQuery = detail.city
      ? [detail.city, detail.state, detail.country].filter((p): p is string => Boolean(p && p.trim())).join(', ')
      : null;
    if (cityQuery) {
      const center = await resolveCoordinates(cityQuery);
      if (center) return center;
    }
    // No city component, or the city geocode failed: coarsen the exact address
    // coordinate to a ~1 km grid so we never store the precise rooftop point.
    return { lat: roundCoord(detail.lat, 2), lng: roundCoord(detail.lng, 2) };
  } catch {
    return null;
  }
}
