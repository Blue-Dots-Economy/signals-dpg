/**
 * Runtime config must WIN over the build-time `import.meta.env` value for every
 * per-deployment UI setting the chart ships in `ui.runtimeConfig`.
 *
 * Why this is worth its own test: `import.meta.env` is inlined by Vite at build
 * time and CI publishes the UI image with no `VITE_` build args, so a deployed
 * instance can only be configured through `window.__DPG_UI_CONFIG__` (written by
 * the chart into `/config.js`). Before this precedence existed, setting
 * `VITE_ENABLED_LANGUAGES` or `VITE_MAP_DEFAULT_CENTER` anywhere in the deploy
 * had no effect at all and failed silently — the dropdown stayed en/hi and the
 * map stayed on whole-India. A regression here is invisible in the UI until
 * someone notices a region is serving the wrong defaults, so assert it directly.
 *
 * The language and map settings resolve at MODULE SCOPE, so those cases need a
 * fresh import (`vi.resetModules()` + dynamic `import()`) with the window stub
 * already in place. The polling/fetch-limit resolvers read per call, so they
 * only need the stub.
 *
 * Note `getRuntimeEnv` treats an EMPTY runtime value as unset and falls through
 * to build-time — which matters because the chart ships
 * `VITE_MAP_DEFAULT_CENTER: ""` by default. Asserted below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `getRuntimeEnv` reads runtime config as an untyped string map, so the stub is
// typed the same way rather than as the narrower `RuntimeConfig` used by
// api-config.ts — these keys are deliberately not on that interface.
type UiConfig = Record<string, string>;

function setRuntimeConfig(cfg: UiConfig | undefined): void {
  if (cfg === undefined) {
    delete (window as Window).__DPG_UI_CONFIG__;
    return;
  }
  (window as Window).__DPG_UI_CONFIG__ = cfg as NonNullable<
    Window['__DPG_UI_CONFIG__']
  >;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  setRuntimeConfig(undefined);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('VITE_ENABLED_LANGUAGES precedence (i18n)', () => {
  it('uses the runtime-config list when present', async () => {
    setRuntimeConfig({ VITE_ENABLED_LANGUAGES: 'en,hi,kn' });
    const { getAvailableLanguages } = await import('@/i18n');
    expect(getAvailableLanguages().map((l) => l.code)).toEqual(['en', 'hi', 'kn']);
  });

  it('lets runtime config OVERRIDE a build-time value', async () => {
    vi.stubEnv('VITE_ENABLED_LANGUAGES', 'en');
    setRuntimeConfig({ VITE_ENABLED_LANGUAGES: 'en,kn' });
    const { getAvailableLanguages } = await import('@/i18n');
    expect(getAvailableLanguages().map((l) => l.code)).toEqual(['en', 'kn']);
  });

  it('falls back to the build-time value when runtime config is absent', async () => {
    vi.stubEnv('VITE_ENABLED_LANGUAGES', 'en,kn');
    setRuntimeConfig(undefined);
    const { getAvailableLanguages } = await import('@/i18n');
    expect(getAvailableLanguages().map((l) => l.code)).toEqual(['en', 'kn']);
  });

  it('falls back to the curated en,hi default when neither is set', async () => {
    setRuntimeConfig(undefined);
    const { getAvailableLanguages } = await import('@/i18n');
    expect(getAvailableLanguages().map((l) => l.code)).toEqual(['en', 'hi']);
  });

  it('carries each locale’s native _name through', async () => {
    setRuntimeConfig({ VITE_ENABLED_LANGUAGES: 'en,hi,kn' });
    const { getAvailableLanguages } = await import('@/i18n');
    const kn = getAvailableLanguages().find((l) => l.code === 'kn');
    expect(kn?.name).toBe('ಕನ್ನಡ');
  });

  it('ignores an enabled code with no locale file', async () => {
    setRuntimeConfig({ VITE_ENABLED_LANGUAGES: 'en,hi,fr' });
    const { getAvailableLanguages } = await import('@/i18n');
    expect(getAvailableLanguages().map((l) => l.code)).toEqual(['en', 'hi']);
  });
});

describe('VITE_MAP_DEFAULT_CENTER / _ZOOM precedence (map-container)', () => {
  it('uses the runtime-config centre and zoom when present', async () => {
    setRuntimeConfig({
      VITE_MAP_DEFAULT_CENTER: '15.4589,75.0078',
      VITE_MAP_DEFAULT_ZOOM: '11',
    });
    const { DEFAULT_CENTER, DEFAULT_ZOOM } = await import(
      '@/components/map/map-container'
    );
    expect(DEFAULT_CENTER).toEqual([15.4589, 75.0078]);
    expect(DEFAULT_ZOOM).toBe(11);
  });

  it('lets runtime config OVERRIDE a build-time centre', async () => {
    vi.stubEnv('VITE_MAP_DEFAULT_CENTER', '29.4727,77.7085');
    setRuntimeConfig({ VITE_MAP_DEFAULT_CENTER: '28.6692,77.4538' });
    const { DEFAULT_CENTER } = await import('@/components/map/map-container');
    expect(DEFAULT_CENTER).toEqual([28.6692, 77.4538]);
  });

  it('falls back to the build-time centre when runtime config is absent', async () => {
    vi.stubEnv('VITE_MAP_DEFAULT_CENTER', '29.4727,77.7085');
    setRuntimeConfig(undefined);
    const { DEFAULT_CENTER } = await import('@/components/map/map-container');
    expect(DEFAULT_CENTER).toEqual([29.4727, 77.7085]);
  });

  it('falls back to whole-India when neither is set', async () => {
    setRuntimeConfig(undefined);
    const { DEFAULT_CENTER, DEFAULT_ZOOM, FALLBACK_CENTER, FALLBACK_ZOOM } =
      await import('@/components/map/map-container');
    expect(DEFAULT_CENTER).toEqual(FALLBACK_CENTER);
    expect(DEFAULT_ZOOM).toBe(FALLBACK_ZOOM);
  });

  it('falls back to whole-India on a malformed runtime centre, rather than throwing', async () => {
    setRuntimeConfig({ VITE_MAP_DEFAULT_CENTER: '15.4589' });
    const { DEFAULT_CENTER, FALLBACK_CENTER } = await import(
      '@/components/map/map-container'
    );
    expect(DEFAULT_CENTER).toEqual(FALLBACK_CENTER);
  });
});

describe('other ui.runtimeConfig values the chart ships', () => {
  it('resolves the action poll interval from runtime config', async () => {
    setRuntimeConfig({ VITE_ACTION_POLL_INTERVAL_MS: '15000' });
    const { resolvePollingInterval } = await import('@/hooks/use-actions');
    expect(resolvePollingInterval()).toBe(15000);
  });

  it('resolves the profile fetch limit from runtime config', async () => {
    setRuntimeConfig({ VITE_PROFILE_FETCH_LIMIT: '250' });
    const { resolveProfileFetchLimit } = await import('@/lib/network-api');
    expect(resolveProfileFetchLimit()).toBe(250);
  });

  it('treats an empty runtime value as unset (the chart default)', async () => {
    setRuntimeConfig({ VITE_MAP_DEFAULT_CENTER: '', VITE_MAP_DEFAULT_ZOOM: '' });
    const { DEFAULT_CENTER, FALLBACK_CENTER, DEFAULT_ZOOM, FALLBACK_ZOOM } =
      await import('@/components/map/map-container');
    expect(DEFAULT_CENTER).toEqual(FALLBACK_CENTER);
    expect(DEFAULT_ZOOM).toBe(FALLBACK_ZOOM);
  });

  it('treats an empty enabled-languages value as unset', async () => {
    setRuntimeConfig({ VITE_ENABLED_LANGUAGES: '' });
    const { getAvailableLanguages } = await import('@/i18n');
    expect(getAvailableLanguages().map((l) => l.code)).toEqual(['en', 'hi']);
  });
});
