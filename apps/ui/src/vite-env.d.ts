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
  readonly VITE_DEFAULT_NETWORK_THEME?: string;
  readonly VITE_DEFAULT_VIEW_MODE?: 'list' | 'map';
  readonly VITE_ACTION_POLL_INTERVAL_MS?: string;
  readonly VITE_VC_WALLET_URL: string;
  readonly VITE_VC_WALLET_API_KEY: string;
  readonly VITE_AGENT_URL: string;
  readonly VITE_AGENT_TOKEN: string;
  readonly VITE_ENABLED_LANGUAGES: string;
}

declare const __DEFAULT_NETWORK_THEME__: string;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
