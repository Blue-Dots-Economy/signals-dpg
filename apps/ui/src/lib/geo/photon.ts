import type { GeoComponents, GeoProvider, GeoSuggestion } from './types';

const DEFAULT_PHOTON_URL = 'https://photon.komoot.io';

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }; // [lng, lat]
  properties?: {
    name?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    /** ISO 3166-1 alpha-2, e.g. `IN`. */
    countrycode?: string;
    /** Feature granularity, e.g. `city`, `district`, `state`, `country`. */
    type?: string;
  };
}

/** Feature types too coarse to stand in for an address (#788). */
const COARSE_TYPES = new Set(['country', 'state']);

/**
 * With a `country`, keep only features inside it and finer than state level.
 * A backstop, not a nicety: an older Photon server ignores `countrycode`.
 */
function inCountry(f: PhotonFeature, country: string): boolean {
  const p = f.properties ?? {};
  return p.countrycode?.toUpperCase() === country && !(p.type && COARSE_TYPES.has(p.type));
}

/** Pure: maps a Photon FeatureCollection JSON into suggestions. Exported for testing. */
export function parsePhotonFeatures(json: unknown): GeoSuggestion[] {
  const features = (json as { features?: PhotonFeature[] })?.features ?? [];
  const out: GeoSuggestion[] = [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length !== 2) continue;
    const [lng, lat] = coords;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const p = f.properties ?? {};
    const label = [p.name, p.city, p.state, p.postcode, p.country]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join(', ');
    const components: GeoComponents = {
      locality: p.name,
      city: p.city,
      state: p.state,
      postcode: p.postcode,
      country: p.country,
    };
    out.push({ label: label || `${lat}, ${lng}`, lat, lng, components });
  }
  return out;
}

/**
 * `country` (ISO 3166-1 alpha-2, e.g. `IN`) restricts suggestions to that
 * country (#788): sent as Photon's `countrycode` param and re-checked on every
 * feature, since an older Photon server answers worldwide regardless.
 */
export function createPhotonProvider(baseUrl = DEFAULT_PHOTON_URL, country?: string): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        const base = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(q)}&limit=5`;
        const url = country ? `${base}&countrycode=${country}` : base;
        const res = await fetch(url, { signal });
        if (!res.ok) return [];
        const json = (await res.json()) as { features?: PhotonFeature[] };
        if (!country) return parsePhotonFeatures(json);
        return parsePhotonFeatures({
          features: (json.features ?? []).filter((f) => inCountry(f, country)),
        });
      } catch {
        return [];
      }
    },
  };
}
