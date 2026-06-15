export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoComponents {
  locality?: string;  // area / sublocality / neighbourhood
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

export interface GeoSuggestion extends LatLng {
  /** Human-readable label shown in the dropdown. */
  label: string;
  components?: GeoComponents;
}

export interface GeoProvider {
  /** Returns ranked suggestions for a free-text query (empty array on error). */
  suggest(query: string, signal?: AbortSignal): Promise<GeoSuggestion[]>;
  /**
   * Forward-geocodes a complete address string to a single coordinate, or null
   * on error / no match. Unlike suggest(), this is a one-shot lookup — no
   * autocomplete predictions and no per-suggestion detail fetches. Used by the
   * map fallback to place items that have no stored item_locations.
   */
  geocode(address: string, signal?: AbortSignal): Promise<LatLng | null>;
}
