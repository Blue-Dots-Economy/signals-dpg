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
}
