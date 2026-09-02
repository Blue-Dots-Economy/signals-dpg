import { defineConfig, devices } from '@playwright/test';
import { loadConfig } from './src/config.js';

/**
 * External-mode Playwright config. The suite runs against an ALREADY-RUNNING
 * signals-dpg instance selected by `E2E_ENV` (default "local"). Nothing is
 * started or torn down here — see e2e/README.md.
 *
 * Projects:
 *  - preflight : target readiness gate; api/ui depend on it (fail fast if down)
 *  - api       : black-box HTTP journeys (no browser)
 *  - ui        : full-stack browser journeys against the running UI + API
 */
const cfg = loadConfig();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry against a shared external target absorbs transient load-flakes
  // (a real failure fails twice; a browser test starved under API load passes on
  // retry). Traces are captured on the first failure regardless.
  retries: process.env.CI ? 2 : 1,
  // Shared external target: keep concurrency modest to avoid hammering it.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  use: {
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    extraHTTPHeaders: cfg.servedBindingHost ? { Host: cfg.servedBindingHost } : undefined,
  },
  projects: [
    {
      name: 'preflight',
      testMatch: /preflight\/.*\.spec\.ts/,
      use: { baseURL: cfg.apiBaseUrl },
    },
    {
      name: 'api',
      testMatch: /api\/.*\.spec\.ts/,
      dependencies: ['preflight'],
      use: { baseURL: cfg.apiBaseUrl },
    },
    {
      name: 'ui',
      testMatch: /ui\/.*\.spec\.ts/,
      dependencies: ['preflight'],
      use: { ...devices['Desktop Chrome'], baseURL: cfg.uiBaseUrl },
    },
  ],
});
