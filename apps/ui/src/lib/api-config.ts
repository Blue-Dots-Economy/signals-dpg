interface ApiEndpoint {
  key: string;
  label: string;
  url: string;
}

class ApiConfig {
  private endpoints: ApiEndpoint[] = [];
  private selectedKey: string | null = null;

  constructor() {
    this.loadFromEnv();
    this.loadFromStorage();
  }

  private loadFromEnv() {
    const urlsJson = import.meta.env.VITE_API_URLS;
    const defaultUrl =
      import.meta.env.VITE_DEFAULT_API_URL ||
      import.meta.env.VITE_API_URL ||
      'http://localhost:2742';

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
    return endpoint?.url ?? this.endpoints[0]?.url ?? 'http://localhost:2742';
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
    if (import.meta.env.VITE_SHOW_INSTANCE_SELECTOR === 'true') return true;
    return import.meta.env.DEV;
  }
}

export const apiConfig = new ApiConfig();
