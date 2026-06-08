import type { GeoProvider, GeoSuggestion } from './types';

type GoogleNS = {
  maps: {
    importLibrary: (name: string) => Promise<Record<string, unknown>>;
  };
};

let scriptPromise: Promise<void> | null = null;

function loadMapsApi(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as unknown as { google?: GoogleNS }).google?.maps?.importLibrary) {
    return Promise.resolve();
  }
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-dpg-google-maps="true"]'
    );
    (window as unknown as { __dpgGoogleMapsInit?: () => void }).__dpgGoogleMapsInit = () => resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('maps load failed')), { once: true });
      return;
    }
    const script = document.createElement('script');
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('libraries', 'places');
    url.searchParams.set('callback', '__dpgGoogleMapsInit');
    url.searchParams.set('loading', 'async');
    url.searchParams.set('v', 'weekly');
    script.src = url.toString();
    script.async = true;
    script.defer = true;
    script.dataset.dpgGoogleMaps = 'true';
    script.onerror = () => reject(new Error('maps load failed'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function createGooglePlacesProvider(apiKey: string): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        await loadMapsApi(apiKey);
        const places = (await (
          window as unknown as { google: GoogleNS }
        ).google.maps.importLibrary('places')) as {
          AutocompleteSessionToken: new () => object;
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: (req: object) => Promise<{
              suggestions: Array<{
                placePrediction: {
                  text: { toString: () => string };
                  toPlace: () => {
                    fetchFields: (req: { fields: string[] }) => Promise<void>;
                    location?: { lat: () => number; lng: () => number };
                  };
                };
              }>;
            }>;
          };
        };

        const token = new places.AutocompleteSessionToken();
        const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          sessionToken: token,
        });

        const top = suggestions.slice(0, 5);
        const resolved = await Promise.all(
          top.map(async (s) => {
            if (signal?.aborted) return null;
            const place = s.placePrediction.toPlace();
            await place.fetchFields({ fields: ['location'] });
            const loc = place.location;
            if (!loc) return null;
            return {
              label: s.placePrediction.text.toString(),
              lat: loc.lat(),
              lng: loc.lng(),
            } satisfies GeoSuggestion;
          })
        );
        return resolved.filter((x): x is GeoSuggestion => x !== null);
      } catch {
        return [];
      }
    },
  };
}
