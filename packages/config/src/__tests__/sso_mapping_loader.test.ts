import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigError } from '../config_error.js';
import {
  loadSsoNcsMappingFile,
  NCS_MAPPING_FILE,
  resolveSsoNcsMapping,
} from '../sso_mapping_loader.js';

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sso-mapping-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

describe('loadSsoNcsMappingFile (local)', () => {
  it('reads the mapping beside network.json', async () => {
    const dir = await dirWith({
      'network.json': '{}',
      [NCS_MAPPING_FILE]: '{"role_to_domain":{"JOBSEEKER":"seeker"}}',
    });
    const file = await loadSsoNcsMappingFile({
      source: 'local',
      localFile: join(dir, 'network.json'),
    });
    expect(file).toEqual({ role_to_domain: { JOBSEEKER: 'seeker' } });
  });

  it('returns null when the instance has no mapping file', async () => {
    const dir = await dirWith({ 'network.json': '{}' });
    expect(
      await loadSsoNcsMappingFile({ source: 'local', localFile: join(dir, 'network.json') })
    ).toBeNull();
  });

  it('fails boot on a file that is not a JSON object', async () => {
    const dir = await dirWith({ 'network.json': '{}', [NCS_MAPPING_FILE]: '[1,2' });
    await expect(
      loadSsoNcsMappingFile({ source: 'local', localFile: join(dir, 'network.json') })
    ).rejects.toThrow(ConfigError);
  });
});

describe('loadSsoNcsMappingFile (remote)', () => {
  const opts = {
    source: 'remote' as const,
    localFile: 'unused',
    remoteUrls: 'blue_dot=https://schemas.example.org/blue_dot/ka-dhwd/network.json',
    servedDomains: [{ network: 'blue_dot', domain: 'seeker' }],
  };

  it('fetches the mapping from the same URL directory as network.json', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('{"fields":{"fullName":"name"}}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await loadSsoNcsMappingFile({ ...opts, fetchImpl })).toEqual({
      fields: { fullName: 'name' },
    });
    expect(urls).toEqual([`https://schemas.example.org/blue_dot/ka-dhwd/${NCS_MAPPING_FILE}`]);
  });

  it('treats a 404 as "no mapping file"', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await loadSsoNcsMappingFile({ ...opts, fetchImpl })).toBeNull();
  });

  it('fails boot on any other HTTP error', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(loadSsoNcsMappingFile({ ...opts, fetchImpl })).rejects.toThrow(ConfigError);
  });
});

describe('resolveSsoNcsMapping', () => {
  it('uses the file, with SSO_NCS_MAPPING keys winning', () => {
    const mapping = resolveSsoNcsMapping(
      {
        network: 'blue_dot',
        role_to_domain: { JOBSEEKER: 'seeker' },
        fields: { fullName: 'name', mobileNumber: 'phone' },
        app_origin: 'https://from-file.example.org',
      },
      '{"app_origin":"http://localhost:5173"}'
    );
    expect(mapping.fields).toEqual({ fullName: 'name', mobileNumber: 'phone' });
    expect(mapping.role_to_domain).toEqual({ JOBSEEKER: 'seeker' });
    expect(mapping.app_origin).toBe('http://localhost:5173');
    expect(mapping.item_type).toBe('profile_1.0');
  });

  it('falls back to SSO_NCS_MAPPING alone when there is no file', () => {
    const mapping = resolveSsoNcsMapping(null, '{"fields":{"fullName":"name"}}');
    expect(mapping.fields).toEqual({ fullName: 'name' });
  });

  it('rejects a mapping of the wrong shape', () => {
    expect(() => resolveSsoNcsMapping({ fields: 'name' }, '{}')).toThrow(ConfigError);
  });
});
