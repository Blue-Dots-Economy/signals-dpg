import { geocodingConfig } from '@/config';
import { buildPlaceCacheKey, getCachedPlace } from './geo_cache';
import { incrWithinWindow } from '@/utils/rate_window';

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
  properties?: {
    countrycode?: string;
    type?: string;
    name?: string;
    city?: string;
    state?: string;
  };
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
  formatted_address?: string;
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

export type PlaceResolution =
  | { kind: 'found'; place: ResolvedPlace }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: 'provider_error' | 'timeout' | 'spend_cap' };

export interface ResolvePlaceOptions {
  /** Per provider call. Unset means no timeout (item-creation behaviour). */
  timeoutMs?: number;
  /** Total tries per live lookup; defaults to `geocodingConfig.retry_attempts`. */
  retryAttempts?: number;
  /** When set, live provider calls through this caller are capped per UTC day. */
  dailyCap?: number;
}

const requestInit = (timeoutMs?: number): RequestInit | undefined =>
  timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined;

async function resolveWithGoogle(
  query: string,
  apiKey: string,
  country?: string,
  timeoutMs?: number,
): Promise<ResolvedPlace | null> {
  const res = await fetch(buildGoogleGeocodeUrl(query, apiKey, country), requestInit(timeoutMs));
  if (!res.ok) throw new Error(`google geocode http ${res.status}`);
  const json = await res.json();
  const status = (json as { status?: string })?.status;
  if (status === 'ZERO_RESULTS') return null; // definitive not-found → cacheable
  if (status !== 'OK') throw new Error(`google geocode status ${status ?? 'unknown'}`); // transient → do not cache
  // Every result foreign or too coarse is a definitive not-found too → cacheable.
  return pickGooglePlace(json, country);
}

async function resolveWithPhoton(
  query: string,
  baseUrl: string,
  country?: string,
  timeoutMs?: number,
): Promise<ResolvedPlace | null> {
  const res = await fetch(buildPhotonUrl(query, baseUrl, country), requestInit(timeoutMs));
  if (!res.ok) throw new Error(`photon http ${res.status}`);
  // Every feature foreign or too coarse is a definitive not-found → cacheable.
  return pickPhotonPlace(await res.json(), query, country);
}

class SpendCapError extends Error {}

/** Counts one live provider call against today's (UTC) budget. */
async function assertWithinDailyCap(cap: number): Promise<void> {
  let count: number;
  try {
    const day = new Date().toISOString().slice(0, 10);
    count = await incrWithinWindow(`geo:spend:resolve:${day}`, 86400);
  } catch {
    // The cap is cost control, not authz: a counter outage must not block lookups.
    return;
  }
  if (count > cap) throw new SpendCapError('geocode daily cap reached');
}

/** Dispatch to the configured provider. Returns null only on a definitive
 *  not-found; throws on transient/HTTP/network errors so the cache layer does
 *  not persist a negative for a temporary failure. */
async function resolveFromProvider(q: string, opts: ResolvePlaceOptions): Promise<ResolvedPlace | null> {
  if (opts.dailyCap !== undefined) await assertWithinDailyCap(opts.dailyCap);
  if (geocodingConfig.google_api_key) {
    return resolveWithGoogle(q, geocodingConfig.google_api_key, geocodingConfig.country, opts.timeoutMs);
  }
  return resolveWithPhoton(q, geocodingConfig.photon_url, geocodingConfig.country, opts.timeoutMs);
}

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Retries a provider resolve only when it throws, i.e. on transient failures
 * such as a bulk upload's 429 burst; a definitive not-found (null) is never
 * re-sent, nor is a spent daily budget.
 *
 * Best-effort only: an item whose geocode fails every attempt is created
 * without coordinates and stays off the map until it is re-saved. Retries land
 * in the same rate-limit window, so a sustained 429 can still cause this.
 */
async function resolveFromProviderWithRetry(
  q: string,
  opts: ResolvePlaceOptions,
): Promise<ResolvedPlace | null> {
  const attempts = Math.max(1, opts.retryAttempts ?? geocodingConfig.retry_attempts);
  const attempt = async (n: number): Promise<ResolvedPlace | null> => {
    try {
      return await resolveFromProvider(q, opts);
    } catch (err) {
      if (err instanceof SpendCapError || n >= attempts) throw err;
      await delay(geocodingConfig.retry_backoff_ms);
      return attempt(n + 1);
    }
  };
  return attempt(1);
}

/** The live lookup (budget check and provider call), run on a cache miss. */
async function lookupLive(q: string, opts: ResolvePlaceOptions): Promise<PlaceResolution> {
  try {
    const place = await resolveFromProviderWithRetry(q, opts);
    if (!place) return { kind: 'not_found' };
    return { kind: 'found', place: { ...place, label: place.label || q } };
  } catch (err) {
    if (err instanceof SpendCapError) return { kind: 'unavailable', reason: 'spend_cap' };
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { kind: 'unavailable', reason: 'timeout' };
    }
    return { kind: 'unavailable', reason: 'provider_error' };
  }
}

const inFlight = new Map<string, Promise<PlaceResolution>>();

/**
 * Resolves an address string to a place, cached in Redis. Uses Google
 * Geocoding when a key is configured, else Photon. Never throws: a provider
 * failure is an `unavailable` outcome and is not cached. Concurrent misses for
 * the same query share one provider call.
 */
export async function resolvePlace(
  query: string,
  opts: ResolvePlaceOptions = {},
): Promise<PlaceResolution> {
  const q = query.trim();
  if (!q) return { kind: 'not_found' };
  const key = buildPlaceCacheKey(q, geocodingConfig.country);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = getCachedPlace(q, () => lookupLive(q, opts), geocodingConfig.country).finally(() =>
    inFlight.delete(key),
  );
  inFlight.set(key, pending);
  return pending;
}

/**
 * Resolves a composite address string to coordinates. Returns null on any
 * failure; callers must treat geocoding as best-effort.
 */
export async function resolveCoordinates(query: string): Promise<Coordinates | null> {
  const result = await resolvePlace(query);
  return result.kind === 'found' ? result.place.point : null;
}

export type PlacePrecision = 'postal_code' | 'locality' | 'city' | 'district';

export interface ResolvedPlace {
  point: Coordinates;
  label: string;
  precision: PlacePrecision;
}

/** Pure: how precisely a Google result's types pin a place. */
export function googlePrecision(types: string[]): PlacePrecision {
  if (types.includes('postal_code')) return 'postal_code';
  if (types.includes('locality')) return 'city';
  if (types.includes('administrative_area_level_2') || types.includes('administrative_area_level_3')) {
    return 'district';
  }
  return 'locality';
}

/** Pure: how precisely a Photon feature type (or a postcode query) pins a place. */
export function photonPrecision(type: string | undefined, query: string): PlacePrecision {
  if (/^\s*\d{4,6}\s*$/.test(query)) return 'postal_code';
  if (type === 'city') return 'city';
  if (type === 'county') return 'district';
  return 'locality';
}

/**
 * Pure: the result `pickGoogleResult` would choose, with label and precision.
 * Without a country only the first result counts, as in `parseGoogleGeocode`.
 */
export function pickGooglePlace(json: unknown, country?: string): ResolvedPlace | null {
  const data = json as { status?: string; results?: GoogleGeocodeResult[] };
  const candidates = country ? (data?.results ?? []) : (data?.results ?? []).slice(0, 1);
  for (const r of candidates) {
    const point = pickGoogleResult({ status: data?.status, results: [r] }, country);
    if (!point) continue;
    return {
      point,
      label: r.formatted_address?.trim() ?? '',
      precision: googlePrecision(r.types ?? []),
    };
  }
  return null;
}

/** Pure: the feature `pickPhotonFeature` would choose, with label and precision. */
export function pickPhotonPlace(
  json: unknown,
  query: string,
  country?: string,
): ResolvedPlace | null {
  const features = (json as { features?: PhotonFeature[] })?.features ?? [];
  for (const f of features) {
    const point = pickPhotonFeature({ features: [f] }, country);
    if (!point) continue;
    const p = f.properties ?? {};
    const parts = [p.name, p.city, p.state]
      .map((v) => v?.trim() ?? '')
      .filter((v, i, all) => v && v !== all.slice(0, i).reverse().find(Boolean));
    return {
      point,
      label: parts.join(', ') || query.trim(),
      precision: photonPrecision(p.type, query),
    };
  }
  return null;
}
