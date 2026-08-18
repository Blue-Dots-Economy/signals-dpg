import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAllowedOrigins } from '../allowed_origins';

const DEFAULTS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:2742',
];

/**
 * `allowed_origins` is computed once at module load from the environment, so
 * each case re-imports the module with a fresh module registry.
 */
async function loadAllowedOrigins(env: {
  NODE_ENV?: string;
  ALLOWED_ORIGINS?: string;
}): Promise<string[]> {
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'test');
  // `undefined` removes the variable entirely, which exercises the unset branch.
  vi.stubEnv('ALLOWED_ORIGINS', env.ALLOWED_ORIGINS);
  vi.resetModules();
  const mod = await import('../allowed_origins');
  return mod.allowed_origins;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('allowed_origins', () => {
  it('falls back to the local dev defaults when ALLOWED_ORIGINS is unset', async () => {
    expect(await loadAllowedOrigins({})).toEqual(DEFAULTS);
  });

  it('augments (not replaces) the defaults outside production', async () => {
    const origins = await loadAllowedOrigins({
      NODE_ENV: 'development',
      ALLOWED_ORIGINS: 'https://ui.example.test',
    });

    expect(origins).toEqual([...DEFAULTS, 'https://ui.example.test']);
  });

  it('de-duplicates an env origin that repeats a default', async () => {
    const origins = await loadAllowedOrigins({
      NODE_ENV: 'development',
      ALLOWED_ORIGINS: 'http://localhost:3000,https://ui.example.test',
    });

    expect(origins).toEqual([...DEFAULTS, 'https://ui.example.test']);
  });

  it('trims whitespace and drops empty entries', async () => {
    const origins = await loadAllowedOrigins({
      NODE_ENV: 'development',
      ALLOWED_ORIGINS: ' https://a.example.test , , https://b.example.test ,',
    });

    expect(origins).toEqual([
      ...DEFAULTS,
      'https://a.example.test',
      'https://b.example.test',
    ]);
  });

  it('strictly overrides the defaults in production so localhost cannot bleed in', async () => {
    const origins = await loadAllowedOrigins({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://app.example.test,https://admin.example.test',
    });

    expect(origins).toEqual(['https://app.example.test', 'https://admin.example.test']);
    expect(origins).not.toContain('http://localhost:3000');
  });

  it('still falls back to the defaults in production when ALLOWED_ORIGINS is empty', async () => {
    expect(await loadAllowedOrigins({ NODE_ENV: 'production', ALLOWED_ORIGINS: ' , ' })).toEqual(
      DEFAULTS
    );
  });
});

describe('mergeAllowedOrigins', () => {
  it('flattens the groups and keeps the first occurrence of each origin', () => {
    expect(
      mergeAllowedOrigins(
        ['https://a.example.test', 'https://b.example.test'],
        ['https://b.example.test', 'https://c.example.test']
      )
    ).toEqual([
      'https://a.example.test',
      'https://b.example.test',
      'https://c.example.test',
    ]);
  });

  it('drops empty-string entries', () => {
    expect(mergeAllowedOrigins(['', 'https://a.example.test'], ['', ''])).toEqual([
      'https://a.example.test',
    ]);
  });

  it('returns [] when called with no groups or only empty groups', () => {
    expect(mergeAllowedOrigins()).toEqual([]);
    expect(mergeAllowedOrigins([], [])).toEqual([]);
  });
});
