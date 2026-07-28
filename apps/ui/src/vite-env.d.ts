/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAP_PROVIDER: string;
  readonly VITE_GOOGLE_MAPS_API_KEY: string;
  readonly VITE_PHOTON_URL?: string;
  readonly VITE_MAPBOX_ACCESS_TOKEN: string;
  readonly VITE_API_URL: string;
  readonly VITE_API_URLS: string;
  readonly VITE_DEFAULT_API_URL: string;
  readonly VITE_SHOW_INSTANCE_SELECTOR: string;
  readonly VITE_NETWORK_ID: string;
  readonly VITE_SERVED_BINDINGS?: string;
  readonly VITE_DEFAULT_NETWORK_THEME?: string;
  readonly VITE_DEFAULT_BRAND?: string;
  readonly VITE_BRAND_NAME?: string;
  readonly VITE_DEFAULT_VIEW_MODE?: 'list' | 'map';
  /** Per-deployment default map centre as "lat,lng" (falls back to Muzaffarnagar). */
  readonly VITE_MAP_DEFAULT_CENTER?: string;
  /** Per-deployment default map zoom (falls back to 12). */
  readonly VITE_MAP_DEFAULT_ZOOM?: string;
  /** Marker cap while zoomed below the cluster-disable zoom (#203 Task 6). Falls back to 1000. */
  readonly VITE_MAP_MARKER_CAP_CLUSTERED?: string;
  /** Marker cap at/above the cluster-disable zoom, once pins render individually (#203 Task 6). Falls back to 500. */
  readonly VITE_MAP_MARKER_CAP_INDIVIDUAL?: string;
  /** Zoom level at/above which the map disables clustering (#203 Task 6). Falls back to 14. */
  readonly VITE_MAP_CLUSTER_DISABLE_ZOOM?: string;
  readonly VITE_ACTION_POLL_INTERVAL_MS?: string;
  readonly VITE_VC_WALLET_URL: string;
  readonly VITE_VC_WALLET_API_KEY: string;
  readonly VITE_AGENT_URL: string;
  readonly VITE_AGENT_TOKEN: string;
  readonly VITE_ENABLED_LANGUAGES: string;
  /** Browser tab title override for the tourist app. Falls back to the resolved brand title, else "Signals". */
  readonly VITE_TOURIST_APP_TITLE?: string;
  /** Dev/preview server port. Falls back to 5173. */
  readonly VITE_UI_PORT?: string;
}

declare const __DEFAULT_NETWORK_THEME__: string;
declare const __DEFAULT_BRAND__: string;
declare const __BRAND_REGISTRY__: Record<string, {
  faviconType?: 'png' | 'svg';
  logoShape?: 'square' | 'wordmark';
  copy?: Record<string, string>;
  brands?: Record<string, { faviconType?: 'png' | 'svg'; logoShape?: 'square' | 'wordmark'; copy?: Record<string, string> }>;
}>;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
