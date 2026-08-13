import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `admin_domains` is derived from ADMIN_DOMAINS once at module load, so each
 * case re-imports the module against a fresh environment.
 */
async function loadAdminDomains(value: string | undefined): Promise<string[]> {
  vi.stubEnv('ADMIN_DOMAINS', value);
  vi.resetModules();
  const mod = await import('../allowed_domains_for_admin');
  return mod.admin_domains;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('admin_domains', () => {
  it('is empty when ADMIN_DOMAINS is unset', async () => {
    expect(await loadAdminDomains(undefined)).toEqual([]);
  });

  it('is empty when ADMIN_DOMAINS is blank or only separators', async () => {
    expect(await loadAdminDomains('')).toEqual([]);
    expect(await loadAdminDomains(' , , ')).toEqual([]);
  });

  it('splits on commas and trims each domain', async () => {
    expect(await loadAdminDomains(' example.test , admin.example.test,')).toEqual([
      'example.test',
      'admin.example.test',
    ]);
  });

  it('keeps a single domain as a one-element list', async () => {
    expect(await loadAdminDomains('example.test')).toEqual(['example.test']);
  });

  it('does not de-duplicate repeated domains (raw pass-through)', async () => {
    expect(await loadAdminDomains('example.test,example.test')).toEqual([
      'example.test',
      'example.test',
    ]);
  });
});
