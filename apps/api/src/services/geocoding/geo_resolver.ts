import { geocodingConfig } from '@/config';
import { getCachedCoordinates } from './geo_cache';

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

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { countrycode?: string; type?: string };
}

/**
 * Photon feature types too coarse to stand in for an address: a country- or
 * state-level answer is a not-found, not a pin.
 */
const COARSE_PHOTON_TYPES = new Set(['country', 'state']);

/**
 * Pure: the first usable Photon feature → coords. Exported for testing.
 *
 * With no `country` this is `parsePhotonFeatures`. With a country it is the
 * first feature inside that country and finer than state level. The country
 * check is required because older Photon servers ignore `countrycode`.
 */
export function pickPhotonFeature(json: unknown, country?: string): Coordinates | null {
  if (!country) return parsePhotonFeatures(json);
  const features = (json as { features?: PhotonFeature[] })?.features ?? [];
  for (const f of features) {
    const p = f.properties ?? {};
    if (p.countrycode?.toUpperCase() !== country) continue;
    if (p.type && COARSE_PHOTON_TYPES.has(p.type)) continue;
    const found = parsePhotonFeatures({ features: [f] });
    if (found) return found;
  }
  return null;
}

/**
 * Pure: the Photon request URL. Exported for testing. With a country it adds
 * `countrycode` and asks for a few results, so the backstop filter in
 * `pickPhotonFeature` still has an in-country match to fall back on.
 */
export function buildPhotonUrl(query: string, baseUrl: string, country?: string): string {
  const base = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(query)}`;
  return country ? `${base}&limit=5&countrycode=${country}` : `${base}&limit=1`;
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

interface GoogleGeocodeResult {
  geometry?: { location?: { lat: number; lng: number } };
  types?: string[];
  address_components?: Array<{ short_name?: string; types?: string[] }>;
}

/**
 * Result types too coarse to stand in for a participant's address. With
 * `components=country:XX`, Google answers an unknown place with the country or
 * state centroid instead of ZERO_RESULTS, so a result that is only one of
 * these types is treated as not found.
 */
const COARSE_GOOGLE_TYPES = new Set(['country', 'administrative_area_level_1', 'political']);

function isCoarseGoogleResult(r: GoogleGeocodeResult): boolean {
  const types = r.types ?? [];
  return types.length > 0 && types.every((t) => COARSE_GOOGLE_TYPES.has(t));
}

function googleResultCountry(r: GoogleGeocodeResult): string | undefined {
  return r.address_components
    ?.find((c) => c.types?.includes('country'))
    ?.short_name?.toUpperCase();
}

/**
 * Pure: the first usable Google result → coords. Exported for testing.
 *
 * With no `country` this is `parseGoogleGeocode`. With a country it is the
 * first result inside that country and finer than state level, backing up the
 * request's `components` filter.
 */
export function pickGoogleResult(json: unknown, country?: string): Coordinates | null {
  if (!country) return parseGoogleGeocode(json);
  const data = json as { status?: string; results?: GoogleGeocodeResult[] };
  if (data?.status !== 'OK') return null;
  for (const r of data.results ?? []) {
    if (googleResultCountry(r) !== country || isCoarseGoogleResult(r)) continue;
    const loc = r.geometry?.location;
    if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
      return { lat: loc.lat, lng: loc.lng };
    }
  }
  return null;
}

/**
 * Pure: the Geocoding API request URL. Exported for testing. Uses `components`
 * because it restricts results to the country; `region` only biases them.
 */
export function buildGoogleGeocodeUrl(query: string, apiKey: string, country?: string): URL {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', apiKey);
  if (country) url.searchParams.set('components', `country:${country}`);
  return url;
}

async function resolveWithGoogle(
  query: string,
  apiKey: string,
  country?: string,
): Promise<Coordinates | null> {
  const res = await fetch(buildGoogleGeocodeUrl(query, apiKey, country));
  if (!res.ok) throw new Error(`google geocode http ${res.status}`);
  const json = await res.json();
  const status = (json as { status?: string })?.status;
  if (status === 'ZERO_RESULTS') return null; // definitive not-found → cacheable
  if (status !== 'OK') throw new Error(`google geocode status ${status ?? 'unknown'}`); // transient → do not cache
  // Every result foreign or too coarse is a definitive not-found too → cacheable.
  return pickGoogleResult(json, country);
}

async function resolveWithPhoton(
  query: string,
  baseUrl: string,
  country?: string,
): Promise<Coordinates | null> {
  const res = await fetch(buildPhotonUrl(query, baseUrl, country));
  if (!res.ok) throw new Error(`photon http ${res.status}`);
  // Every feature foreign or too coarse is a definitive not-found → cacheable.
  return pickPhotonFeature(await res.json(), country);
}

/** Dispatch to the configured provider. Returns null only on a definitive
 *  not-found; throws on transient/HTTP/network errors so the cache layer does
 *  not persist a negative for a temporary failure. */
async function resolveFromProvider(q: string): Promise<Coordinates | null> {
  if (geocodingConfig.google_api_key) {
    return resolveWithGoogle(q, geocodingConfig.google_api_key, geocodingConfig.country);
  }
  return resolveWithPhoton(q, geocodingConfig.photon_url, geocodingConfig.country);
}

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Retries a provider resolve (`retry_attempts` tries) only when it throws, i.e.
 * on transient failures such as a bulk upload's 429 burst; a definitive
 * not-found (null) is never re-sent.
 *
 * Best-effort only: an item whose geocode fails every attempt is created
 * without coordinates and stays off the map until it is re-saved. Retries land
 * in the same rate-limit window, so a sustained 429 can still cause this.
 */
async function resolveFromProviderWithRetry(q: string): Promise<Coordinates | null> {
  const attempts = Math.max(1, geocodingConfig.retry_attempts);
  // After the last try the error propagates; the cache layer then returns
  // null and caches nothing, so a later save retries live.
  const attempt = async (n: number): Promise<Coordinates | null> => {
    try {
      return await resolveFromProvider(q);
    } catch (err) {
      if (n >= attempts) throw err;
      await delay(geocodingConfig.retry_backoff_ms);
      return attempt(n + 1);
    }
  };
  return attempt(1);
}

/**
 * Resolves a composite address string to coordinates, cached in Redis. Uses
 * Google Geocoding when a key is configured, else Photon. Returns null on any
 * failure; callers must treat geocoding as best-effort.
 */
export async function resolveCoordinates(query: string): Promise<Coordinates | null> {
  const q = query.trim();
  if (!q) return null;
  return getCachedCoordinates(q, () => resolveFromProviderWithRetry(q), geocodingConfig.country);
}
