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
