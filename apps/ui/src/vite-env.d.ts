/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAP_PROVIDER: string;
  readonly VITE_GOOGLE_MAPS_API_KEY: string;
  readonly VITE_MAPBOX_ACCESS_TOKEN: string;
  readonly VITE_GEOCODING_API_URL: string;
  readonly VITE_API_URL: string;
  readonly VITE_API_URLS: string;
  readonly VITE_DEFAULT_API_URL: string;
  readonly VITE_SHOW_INSTANCE_SELECTOR: string;
  readonly VITE_NETWORK_ID: string;
  readonly VITE_VC_WALLET_URL: string;
  readonly VITE_VC_WALLET_API_KEY: string;
  readonly VITE_AGENT_URL: string;
  readonly VITE_AGENT_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
