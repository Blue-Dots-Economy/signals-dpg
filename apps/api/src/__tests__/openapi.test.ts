import { describe, it, expect } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load the committed dump env BEFORE the config module is imported.
loadEnv({ path: fileURLToPath(new URL('../../scripts/dump_openapi.env', import.meta.url)) });

describe('OpenAPI spec generation', () => {
  it('builds a spec with real metadata and a non-empty path surface', async () => {
    const { buildApp } = await import('@/app');
    const app = await buildApp();
    await app.ready();
    const spec = app.swagger() as {
      info: { title: string; version: string };
      servers?: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };
    expect(spec.info.title).toBe('Signals DPG API');
    expect(spec.info.version).not.toBe(''); // sourced from package.json
    expect(spec.servers?.[0]?.url).toBeTruthy();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
    expect(spec.paths['/api/v1/item/fetch']).toBeTruthy();
    await app.close();
  }, 30_000);
});
