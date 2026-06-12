interface ApiEndpoint {
  key: string;
  label: string;
  url: string;
}

interface RuntimeConfig {
  VITE_API_URL?: string;
  VITE_API_URLS?: string;
  VITE_DEFAULT_API_URL?: string;
  VITE_NETWORK_NAME?: string;
  VITE_SHOW_INSTANCE_SELECTOR?: string;
  // GA4 measurement ID. When set by a deployment's config.js, public/analytics.js
  // loads gtag.js for that deployment; empty/unset = analytics off.
  VITE_ANALYTICS_GA_ID?: string;
}

declare global {
  interface Window {
    __DPG_UI_CONFIG__?: RuntimeConfig;
  }
}

class ApiConfig {
  private endpoints: ApiEndpoint[] = [];
  private selectedKey: string | null = null;

  constructor() {
    this.loadFromEnv();
    this.loadFromStorage();
  }

  private loadFromEnv() {
    const runtime: RuntimeConfig =
      (typeof window !== 'undefined' && window.__DPG_UI_CONFIG__) || {};
    const urlsJson = runtime.VITE_API_URLS || import.meta.env.VITE_API_URLS;
    // Runtime config wins. Empty string in runtime config means "relative to
    // current origin" — axios baseURL='' → browser resolves to current host.
    //
    // No-runtime-config fallback hierarchy:
    //   1. compile-time VITE_DEFAULT_API_URL / VITE_API_URL (if baked at build)
    //   2. in DEV (vite dev server), localhost:2742 so `pnpm dev:ui` works
    //   3. in PROD, empty string → same-origin; nginx in the UI image
    //      reverse-proxies /api/* to dpg-api. This way a missing /config.js
    //      script tag won't strand the browser on localhost:2742.
    const runtimeProvided =
      'VITE_DEFAULT_API_URL' in runtime || 'VITE_API_URL' in runtime;
    const compileTime =
      import.meta.env.VITE_DEFAULT_API_URL || import.meta.env.VITE_API_URL;
    const defaultUrl = runtimeProvided
      ? runtime.VITE_DEFAULT_API_URL || runtime.VITE_API_URL || ''
      : compileTime || (import.meta.env.DEV ? 'http://localhost:2742' : '');

    this.endpoints.push({
      key: 'default',
      label: `Default (${defaultUrl})`,
      url: defaultUrl,
    });

    if (urlsJson) {
      try {
        const parsed = JSON.parse(urlsJson);
        for (const [key, url] of Object.entries(parsed)) {
          this.endpoints.push({
            key,
            label: `${key} (${url as string})`,
            url: url as string,
          });
        }
      } catch {
        // Invalid JSON, skip additional URLs
      }
    }
  }

  private loadFromStorage() {
    const stored = localStorage.getItem('selectedApiUrl');
    if (stored && this.endpoints.some((e) => e.key === stored)) {
      this.selectedKey = stored;
    }
  }

  getUrl(): string {
    const endpoint = this.endpoints.find(
      (e) => e.key === this.selectedKey
    );
    return endpoint?.url ?? this.endpoints[0]?.url ?? '';
  }

  getEndpoints(): ApiEndpoint[] {
    return this.endpoints;
  }

  getSelectedKey(): string | null {
    return this.selectedKey;
  }

  setSelectedKey(key: string) {
    this.selectedKey = key;
    localStorage.setItem('selectedApiUrl', key);
  }

  isDevMode(): boolean {
    const runtime: RuntimeConfig =
      (typeof window !== 'undefined' && window.__DPG_UI_CONFIG__) || {};
    if (runtime.VITE_SHOW_INSTANCE_SELECTOR === 'true') return true;
    if (import.meta.env.VITE_SHOW_INSTANCE_SELECTOR === 'true') return true;
    return import.meta.env.DEV;
  }
}

export const apiConfig = new ApiConfig();
