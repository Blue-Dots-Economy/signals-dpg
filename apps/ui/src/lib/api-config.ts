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
  VITE_BRAND_NAME?: string;
  VITE_SHOW_INSTANCE_SELECTOR?: string;
  // GA4 measurement ID; when set, public/analytics.js loads gtag.js. Unset = analytics off.
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
    // Runtime config wins; '' means same-origin (axios baseURL '').
    // Without runtime config: the build-time VITE_DEFAULT_API_URL / VITE_API_URL,
    // else localhost:2742 in dev, else '' in production, where the UI image's
    // nginx proxies /api/* to the API, so a missing /config.js cannot strand
    // the browser on localhost.
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
        // Invalid JSON: skip the extra URLs.
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
