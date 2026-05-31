export interface GeoCoordinate {
  lat: number;
  lng: number;
}

declare global {
  interface Window {
    __dpgGoogleMapsInit?: () => void;
    google?: GoogleMapsGlobal;
  }
}

interface GoogleMapsGeocoderResult {
  geometry: {
    location: {
      lat: () => number;
      lng: () => number;
    };
  };
}

interface GoogleMapsGeocoder {
  geocode: (request: { address: string }) => Promise<{ results: GoogleMapsGeocoderResult[] }>;
}

interface GoogleMapsGlobal {
  maps?: {
    Geocoder?: new () => GoogleMapsGeocoder;
  };
}

// Caches store the PROMISE, not the resolved value, so concurrent callers for the
// same key share the same in-flight network request instead of all racing to fetch.
// Previously the cache held the resolved value: a render that triggered 11 simultaneous
// lookups for pincode 560102 produced 11 network calls (see HAR analysis), because
// every caller saw `cache.has(key) === false` before any of them got to `cache.set`.
const pincodeCache = new Map<string, Promise<GeoCoordinate | null>>();
const addressCache = new Map<string, Promise<GeoCoordinate | null>>();
const googleAddressCache = new Map<string, Promise<GeoCoordinate | null>>();
let googleMapsScriptPromise: Promise<void> | null = null;

// Rate limiting for Nominatim (1 request per second max per their usage policy).
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000;

async function rateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }

  lastRequestTime = Date.now();
  return fn();
}

// ---------------------------------------------------------------------------
// Mask detection — skip geocoding for PII masks
// ---------------------------------------------------------------------------

/**
 * Returns true for strings that look like PII masks emitted by the API's
 * type-aware masking (see PR #37): "M***", "a***@example.com", "+91-XX-XXXX-X123",
 * "XXXX-XX-XX", or anything that's >=50% asterisks/Xs.
 *
 * Without this guard the UI would geocode the mask itself — observed in HAR
 * logs as 17 wasted Nominatim calls for `q=***`.
 */
export function looksLikePIIMask(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // Common mask: any string containing "***" outside of a URL/email-ish shape.
  if (/\*{3,}/.test(trimmed)) return true;
  // Phone-style: contains "XX" runs (e.g. "+91-XX-XXXX-X123")
  if (/X{3,}/.test(trimmed)) return true;
  // Heuristic: anything where mask-chars are >= 40% of the string
  const maskChars = trimmed.match(/[*X]/g)?.length ?? 0;
  return maskChars / trimmed.length >= 0.4;
}

// ---------------------------------------------------------------------------
// localStorage persistence — survive page reloads
// ---------------------------------------------------------------------------

const LS_PREFIX = 'dpg:geo:';
const LS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days; geo data is stable.

interface PersistedEntry {
  coords: GeoCoordinate | null;
  ts: number;
}

function readPersisted(key: string): GeoCoordinate | null | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as PersistedEntry;
    if (Date.now() - entry.ts > LS_TTL_MS) {
      window.localStorage.removeItem(LS_PREFIX + key);
      return undefined;
    }
    return entry.coords;
  } catch {
    return undefined;
  }
}

function writePersisted(key: string, coords: GeoCoordinate | null): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: PersistedEntry = { coords, ts: Date.now() };
    window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry));
  } catch {
    // Quota exceeded or storage disabled — silently degrade, in-memory cache still works.
  }
}

/**
 * Geocodes a pincode string to latitude/longitude coordinates.
 * Results are cached across the in-memory promise cache AND localStorage,
 * so the same pincode is never fetched twice per user.
 *
 * Resolution order:
 *   1. In-memory promise cache (in-flight dedup)
 *   2. localStorage (30-day persistence)
 *   3. Custom geocoding API (VITE_GEOCODING_API_URL)
 *   4. Default: India postal pincode API (api.postalpincode.in)
 */
export async function geocodePincode(pincode: string): Promise<GeoCoordinate | null> {
  if (!pincode || typeof pincode !== 'string') return null;
  const key = pincode.trim();
  if (!key) return null;

  const cached = pincodeCache.get(key);
  if (cached) return cached;

  // localStorage hit short-circuits before any network call.
  const persisted = readPersisted(`pin:${key}`);
  if (persisted !== undefined) {
    const resolved = Promise.resolve(persisted);
    pincodeCache.set(key, resolved);
    return resolved;
  }

  const customUrl = import.meta.env.VITE_GEOCODING_API_URL;
  const fetcher = customUrl
    ? geocodeFromCustomApi(customUrl, key)
    : geocodeFromPostalApi(key);

  const promise = fetcher
    .catch(() => null)
    .then((result) => {
      writePersisted(`pin:${key}`, result);
      return result;
    });

  pincodeCache.set(key, promise);
  return promise;
}

async function geocodeFromPostalApi(pincode: string): Promise<GeoCoordinate | null> {
  const response = await fetch(`https://api.postalpincode.in/pincode/${pincode}`);
  if (!response.ok) return null;

  const data = await response.json();
  const postOffice = data?.[0]?.PostOffice?.[0];

  if (postOffice?.Latitude && postOffice?.Longitude) {
    return {
      lat: Number(postOffice.Latitude),
      lng: Number(postOffice.Longitude),
    };
  }

  return null;
}

async function geocodeFromCustomApi(
  baseUrl: string,
  pincode: string,
): Promise<GeoCoordinate | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(pincode)}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json();

  // Flexible response parsing — support common geocoding API formats
  if (typeof data.lat === 'number' && typeof data.lng === 'number') {
    return { lat: data.lat, lng: data.lng };
  }
  if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
    return { lat: data.latitude, lng: data.longitude };
  }
  if (Array.isArray(data) && data[0]?.lat && data[0]?.lng) {
    return { lat: Number(data[0].lat), lng: Number(data[0].lng) };
  }

  return null;
}

/**
 * Geocodes an address string to latitude/longitude coordinates using OpenStreetMap Nominatim.
 * Results are cached in-memory (in-flight dedup) and in localStorage (30-day persistence).
 * Skips geocoding when the input looks like a PII mask.
 *
 * Rate limited to 1 request per second per Nominatim's usage policy.
 */
export async function geocodeAddress(
  address: string,
  format: 'full' | 'city-only' = 'full',
): Promise<GeoCoordinate | null> {
  if (!address || typeof address !== 'string') return null;
  if (looksLikePIIMask(address)) return null;

  const trimmed = address.trim();
  if (!trimmed) return null;
  const key = `${format}:${trimmed}`;

  const cached = addressCache.get(key);
  if (cached) return cached;

  const persisted = readPersisted(`addr:${key}`);
  if (persisted !== undefined) {
    const resolved = Promise.resolve(persisted);
    addressCache.set(key, resolved);
    return resolved;
  }

  const promise = rateLimit(() => geocodeFromNominatim(trimmed, format))
    .catch(() => null)
    .then((result) => {
      writePersisted(`addr:${key}`, result);
      return result;
    });

  addressCache.set(key, promise);
  return promise;
}

/**
 * Geocodes a free-form address with Google Geocoding API when a browser API key
 * is configured. In-flight dedup + localStorage persistence + PII-mask guard.
 */
export async function geocodeAddressWithGoogle(address: string): Promise<GeoCoordinate | null> {
  if (!address || typeof address !== 'string') return null;
  if (looksLikePIIMask(address)) return null;

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey || typeof window === 'undefined') return null;

  const key = address.trim();
  if (!key) return null;

  const cached = googleAddressCache.get(key);
  if (cached) return cached;

  const persisted = readPersisted(`google:${key}`);
  if (persisted !== undefined) {
    const resolved = Promise.resolve(persisted);
    googleAddressCache.set(key, resolved);
    return resolved;
  }

  const promise = loadGoogleMapsScript(apiKey)
    .then(() => geocodeWithGoogleMaps(key))
    .catch(() => null)
    .then((result) => {
      writePersisted(`google:${key}`, result);
      return result;
    });

  googleAddressCache.set(key, promise);
  return promise;
}

function hasGoogleGeocoder(): boolean {
  return typeof window.google?.maps?.Geocoder === 'function';
}

function loadGoogleMapsScript(apiKey: string): Promise<void> {
  if (hasGoogleGeocoder()) return Promise.resolve();
  if (googleMapsScriptPromise) return googleMapsScriptPromise;

  googleMapsScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-dpg-google-maps="true"]');

    window.__dpgGoogleMapsInit = () => {
      resolve();
      window.__dpgGoogleMapsInit = undefined;
    };

    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Failed to load Google Maps')), { once: true });
      return;
    }

    const script = document.createElement('script');
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('callback', '__dpgGoogleMapsInit');
    url.searchParams.set('loading', 'async');

    script.src = url.toString();
    script.async = true;
    script.defer = true;
    script.dataset.dpgGoogleMaps = 'true';
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });

  return googleMapsScriptPromise;
}

function geocodeWithGoogleMaps(address: string): Promise<GeoCoordinate | null> {
  if (!hasGoogleGeocoder()) return Promise.resolve(null);

  const Geocoder = window.google?.maps?.Geocoder;
  if (!Geocoder) return Promise.resolve(null);

  const geocoder = new Geocoder();
  return geocoder
    .geocode({ address })
    .then(({ results }) => {
      const location = results[0]?.geometry.location;
      return location ? { lat: location.lat(), lng: location.lng() } : null;
    })
    .catch(() => null);
}

async function geocodeFromNominatim(
  address: string,
  format: 'full' | 'city-only',
): Promise<GeoCoordinate | null> {
  // Build query based on format preference
  let query = address;

  if (format === 'city-only') {
    // Extract just the city/primary location component
    const parts = address.split(',');
    query = parts[0].trim();
  }

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DPG-Map-Viewer/1.0',
    },
  });

  if (!response.ok) return null;

  const data = await response.json();

  if (Array.isArray(data) && data.length > 0 && data[0].lat && data[0].lon) {
    return {
      lat: Number(data[0].lat),
      lng: Number(data[0].lon),
    };
  }

  return null;
}

/**
 * Clears the in-memory caches AND the localStorage persistence.
 * Useful for tests and the dev "clear cache" affordance.
 */
export function clearGeocodingCache(): void {
  pincodeCache.clear();
  addressCache.clear();
  googleAddressCache.clear();
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // localStorage disabled — nothing to clear.
  }
}
