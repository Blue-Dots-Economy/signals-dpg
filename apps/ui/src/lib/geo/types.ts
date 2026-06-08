export interface GeoSuggestion {
  /** Human-readable label shown in the dropdown. */
  label: string;
  lat: number;
  lng: number;
}

export interface GeoProvider {
  /** Returns ranked suggestions for a free-text query (empty array on error). */
  suggest(query: string, signal?: AbortSignal): Promise<GeoSuggestion[]>;
}
