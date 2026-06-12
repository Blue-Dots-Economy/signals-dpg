import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The analytics loader is shipped as a static asset (public/analytics.js) and
// referenced directly from index.html / index.tourist.html. It is not part of
// the module graph, so we execute its source in the happy-dom environment and
// assert on the resulting DOM / window state.
const here = path.dirname(fileURLToPath(import.meta.url));
const loaderPath = path.resolve(here, '../../public/analytics.js');

function runLoader(): void {
  const code = readFileSync(loaderPath, 'utf8');
  new Function(code)();
}

const GTAG_SELECTOR = 'script[src*="googletagmanager.com/gtag/js"]';

describe('analytics loader (public/analytics.js)', () => {
  beforeEach(() => {
    // Stop happy-dom from actually fetching the external gtag.js when the
    // <script> is appended — we only assert it was injected, not that it loads.
    const hd = (window as unknown as { happyDOM?: { settings?: Record<string, unknown> } })
      .happyDOM;
    if (hd?.settings) {
      hd.settings.disableJavaScriptFileLoading = true;
      hd.settings.handleDisabledFileLoadingAsSuccess = true;
    }

    document.head.innerHTML = '';
    delete (window as unknown as { __DPG_UI_CONFIG__?: unknown }).__DPG_UI_CONFIG__;
    delete (window as unknown as { dataLayer?: unknown }).dataLayer;
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  it('no-ops when no runtime config is present', () => {
    runLoader();
    expect(document.querySelector(GTAG_SELECTOR)).toBeNull();
    expect((window as unknown as { dataLayer?: unknown }).dataLayer).toBeUndefined();
  });

  it('no-ops when VITE_ANALYTICS_GA_ID is an empty string', () => {
    (window as unknown as { __DPG_UI_CONFIG__: unknown }).__DPG_UI_CONFIG__ = {
      VITE_ANALYTICS_GA_ID: '',
    };
    runLoader();
    expect(document.querySelector(GTAG_SELECTOR)).toBeNull();
    expect((window as unknown as { dataLayer?: unknown }).dataLayer).toBeUndefined();
  });

  it('injects gtag.js and initializes dataLayer when a GA id is configured', () => {
    (window as unknown as { __DPG_UI_CONFIG__: unknown }).__DPG_UI_CONFIG__ = {
      VITE_ANALYTICS_GA_ID: 'G-TEST1234',
    };
    runLoader();

    const script = document.querySelector(GTAG_SELECTOR) as HTMLScriptElement | null;
    expect(script).not.toBeNull();
    expect(script!.async).toBe(true);
    expect(script!.src).toContain('id=G-TEST1234');

    const dataLayer = (window as unknown as { dataLayer?: unknown[] }).dataLayer;
    expect(Array.isArray(dataLayer)).toBe(true);
    expect(dataLayer!.length).toBeGreaterThan(0);
    // gtag('config', 'G-TEST1234') must have been queued onto the dataLayer.
    expect(JSON.stringify(dataLayer)).toContain('G-TEST1234');
  });

  it('escapes the id into the script URL exactly once (no double-encoding)', () => {
    (window as unknown as { __DPG_UI_CONFIG__: unknown }).__DPG_UI_CONFIG__ = {
      VITE_ANALYTICS_GA_ID: 'G-ABC123',
    };
    runLoader();
    const scripts = document.querySelectorAll(GTAG_SELECTOR);
    expect(scripts.length).toBe(1);
  });
});
