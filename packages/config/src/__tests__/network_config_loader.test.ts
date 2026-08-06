import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNetworkConfigs } from '../network_config_loader';

type NetworkDocument = Record<string, unknown>;

/**
 * A minimal network.json document. NetworkConfigSchema fills the rest in with
 * defaults (domains/instances/actions/cross_network_origins).
 */
function networkDoc(id: string, extra: NetworkDocument = {}): NetworkDocument {
  return { id, display_name: id, ...extra };
}

/**
 * The loader reaches the wire through `new fetchSchema(url).getSchema()`, which
 * uses the global fetch. Stubbing fetch keeps the real schema-registry client
 * and the real NetworkConfigSchema in play.
 */
const fetched = vi.fn((_url: string) => undefined);
let responses: Record<string, NetworkDocument> = {};

beforeEach(() => {
  responses = {};
  fetched.mockClear();
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = input.toString();
    fetched(url);
    const body = responses[url];
    if (!body) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function writeLocalNetworkFile(doc: NetworkDocument): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dpg-network-config-'));
  const file = join(dir, 'network.json');
  await writeFile(file, JSON.stringify(doc), 'utf8');
  return file;
}

describe('loadNetworkConfigs (local source)', () => {
  it('reads exactly one config from disk and never touches the network', async () => {
    const file = await writeLocalNetworkFile(networkDoc('yellow_dot'));

    const configs = await loadNetworkConfigs({ source: 'local', localFile: file });

    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('yellow_dot');
    // Local configs carry no source_url — that is only set on fetched documents.
    expect(configs[0].source_url).toBeUndefined();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('still fetches a declared cross_network_origin remotely (local != offline)', async () => {
    const originUrl = 'https://reg.example.test/blue_dot/network.json';
    responses[originUrl] = networkDoc('blue_dot');

    const file = await writeLocalNetworkFile(
      networkDoc('yellow_dot', {
        cross_network_origins: [{ id: 'blue_dot', schema_url: originUrl }],
      })
    );

    const configs = await loadNetworkConfigs({ source: 'local', localFile: file });

    expect(configs.map((c) => c.id)).toEqual(['yellow_dot', 'blue_dot']);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveBeenCalledWith(originUrl);
    expect(configs[1].source_url).toBe(originUrl);
  });

  it('propagates a read failure for a missing local file', async () => {
    await expect(
      loadNetworkConfigs({ source: 'local', localFile: join(tmpdir(), 'no-such-network.json') })
    ).rejects.toThrow(/ENOENT/);
  });

  it('rejects a local document that is not a valid network config', async () => {
    const file = await writeLocalNetworkFile({ display_name: 'no id here' });

    await expect(loadNetworkConfigs({ source: 'local', localFile: file })).rejects.toThrow();
  });
});

describe('loadNetworkConfigs (remote source)', () => {
  it('throws when neither NETWORK_CONFIG_URLS nor SCHEMA_REGISTRY_URL is resolvable', async () => {
    await expect(
      loadNetworkConfigs({ source: 'remote', localFile: 'unused.json' })
    ).rejects.toThrow(/NETWORK_CONFIG_URLS or SCHEMA_REGISTRY_URL is required/);
  });

  it('fetches every URL from NETWORK_CONFIG_URLS and stamps source_url', async () => {
    responses['https://a.example.test/network.json'] = networkDoc('yellow_dot');
    responses['https://b.example.test/network.json'] = networkDoc('blue_dot');

    const configs = await loadNetworkConfigs({
      source: 'remote',
      localFile: 'unused.json',
      remoteUrls:
        'yellow_dot=https://a.example.test/network.json,blue_dot=https://b.example.test/network.json',
    });

    expect(configs.map((c) => c.id).sort()).toEqual(['blue_dot', 'yellow_dot']);
    expect(configs.map((c) => c.source_url).sort()).toEqual([
      'https://a.example.test/network.json',
      'https://b.example.test/network.json',
    ]);
  });

  it('derives URLs from SCHEMA_REGISTRY_URL plus the served domains', async () => {
    responses['https://reg.example.test/schemas/yellow_dot/network.json'] =
      networkDoc('yellow_dot');

    const configs = await loadNetworkConfigs({
      source: 'remote',
      localFile: 'unused.json',
      schemaRegistryUrls: 'https://reg.example.test/schemas',
      servedDomains: [
        { network: 'yellow_dot', domain: 'student', key: 'yellow_dot/student' },
        { network: 'yellow_dot', domain: 'tutor', key: 'yellow_dot/tutor' },
      ],
    });

    expect(configs.map((c) => c.id)).toEqual(['yellow_dot']);
    // The two served domains of one network collapse to a single fetch.
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('prefers NETWORK_CONFIG_URLS over SCHEMA_REGISTRY_URL when both are set', async () => {
    responses['https://explicit.example.test/network.json'] = networkDoc('yellow_dot');

    await loadNetworkConfigs({
      source: 'remote',
      localFile: 'unused.json',
      remoteUrls: 'yellow_dot=https://explicit.example.test/network.json',
      schemaRegistryUrls: 'https://reg.example.test/schemas',
      servedDomains: [
        { network: 'yellow_dot', domain: 'student', key: 'yellow_dot/student' },
      ],
    });

    expect(fetched).toHaveBeenCalledWith('https://explicit.example.test/network.json');
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-OK response as a schema fetch error', async () => {
    await expect(
      loadNetworkConfigs({
        source: 'remote',
        localFile: 'unused.json',
        remoteUrls: 'yellow_dot=https://missing.example.test/network.json',
      })
    ).rejects.toThrow(/Failed to fetch schema/);
  });
});

describe('loadOneHopCrossNetworkConfigs (via loadNetworkConfigs)', () => {
  it('does NOT recurse into a fetched origin\'s own cross_network_origins (one-hop cap)', async () => {
    const blueUrl = 'https://reg.example.test/blue_dot/network.json';
    const orangeUrl = 'https://reg.example.test/orange_dot/network.json';

    // blue_dot itself declares orange_dot — deliberately never followed.
    responses[blueUrl] = networkDoc('blue_dot', {
      cross_network_origins: [{ id: 'orange_dot', schema_url: orangeUrl }],
    });
    responses[orangeUrl] = networkDoc('orange_dot');

    const file = await writeLocalNetworkFile(
      networkDoc('yellow_dot', {
        cross_network_origins: [{ id: 'blue_dot', schema_url: blueUrl }],
      })
    );

    const configs = await loadNetworkConfigs({ source: 'local', localFile: file });

    expect(configs.map((c) => c.id)).toEqual(['yellow_dot', 'blue_dot']);
    expect(configs.map((c) => c.id)).not.toContain('orange_dot');
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched).not.toHaveBeenCalledWith(orangeUrl);
  });

  it('skips an origin whose network is already among the base configs', async () => {
    responses['https://a.example.test/network.json'] = networkDoc('yellow_dot', {
      cross_network_origins: [
        { id: 'blue_dot', schema_url: 'https://b.example.test/network.json' },
      ],
    });
    responses['https://b.example.test/network.json'] = networkDoc('blue_dot');

    const configs = await loadNetworkConfigs({
      source: 'remote',
      localFile: 'unused.json',
      remoteUrls:
        'yellow_dot=https://a.example.test/network.json,blue_dot=https://b.example.test/network.json',
    });

    expect(configs).toHaveLength(2);
    // Two base fetches only: the cross-network origin resolves to an already
    // loaded config, so it is not fetched a second time.
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('fetches a shared origin only once when two base configs declare it', async () => {
    const blueUrl = 'https://reg.example.test/blue_dot/network.json';
    responses[blueUrl] = networkDoc('blue_dot');
    responses['https://a.example.test/network.json'] = networkDoc('yellow_dot', {
      cross_network_origins: [{ id: 'blue_dot', schema_url: blueUrl }],
    });
    responses['https://c.example.test/network.json'] = networkDoc('purple_dot', {
      cross_network_origins: [{ id: 'blue_dot', schema_url: blueUrl }],
    });

    const configs = await loadNetworkConfigs({
      source: 'remote',
      localFile: 'unused.json',
      remoteUrls:
        'yellow_dot=https://a.example.test/network.json,purple_dot=https://c.example.test/network.json',
    });

    expect(configs.map((c) => c.id).sort()).toEqual([
      'blue_dot',
      'purple_dot',
      'yellow_dot',
    ]);
    expect(fetched.mock.calls.filter(([url]) => url === blueUrl)).toHaveLength(1);
  });

  it('throws when the origin URL serves a different network id than declared', async () => {
    const originUrl = 'https://reg.example.test/blue_dot/network.json';
    responses[originUrl] = networkDoc('green_dot');

    const file = await writeLocalNetworkFile(
      networkDoc('yellow_dot', {
        cross_network_origins: [{ id: 'blue_dot', schema_url: originUrl }],
      })
    );

    await expect(
      loadNetworkConfigs({ source: 'local', localFile: file })
    ).rejects.toThrow(
      'Cross-network origin "blue_dot" loaded schema for network "green_dot".'
    );
  });
});
