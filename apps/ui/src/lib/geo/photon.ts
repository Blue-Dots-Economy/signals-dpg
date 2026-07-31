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
  };
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

export function createPhotonProvider(baseUrl = DEFAULT_PHOTON_URL): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        const url = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(q)}&limit=5`;
        const res = await fetch(url, { signal });
        if (!res.ok) return [];
        return parsePhotonFeatures(await res.json());
      } catch {
        return [];
      }
    },
  };
}
