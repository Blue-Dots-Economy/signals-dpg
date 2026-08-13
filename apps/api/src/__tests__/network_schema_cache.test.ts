import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- mocks (hoisted) -------------------------------------------------------
// The module under test is a *disk-backed* cache rooted at
// `tmpdir()/dpg-network-schema-cache`. We swap `node:fs/promises` for an
// in-memory filesystem so the real read/write/index bookkeeping still runs
// (no stubbing of the module's own logic) without touching a real disk.
const {
  fsState,
  dbState,
  fetchedUrls,
  getSchemaMock,
  getDomainItemSchemaMock,
  getNetworkConfigs,
  refreshNetworkConfigs,
  refreshConsentConfigs,
} = vi.hoisted(() => ({
  fsState: {
    files: new Map<string, string>(),
    mkdirCalls: [] as string[],
  },
  // Resettable failure switch for the drizzle fake. Never monkey-patch the
  // shared row queue: an override there leaks into every later test.
  dbState: {
    failWith: null as Error | null,
    rows: [] as Array<Record<string, unknown>>,
    lastWhere: null as unknown,
    lastSelection: null as unknown,
  },
  fetchedUrls: [] as string[],
  getSchemaMock: vi.fn((_url: string): Promise<Record<string, unknown>> | Record<string, unknown> => ({})),
  getDomainItemSchemaMock: vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (..._args: any[]): Record<string, unknown> => ({ resolved: 'domain-item-schema' })
  ),
  getNetworkConfigs: vi.fn(async (): Promise<unknown[]> => []),
  refreshNetworkConfigs: vi.fn(async (): Promise<unknown[]> => []),
  refreshConsentConfigs: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: async (path: string) => {
    fsState.mkdirCalls.push(path);
  },
  readFile: async (path: string) => {
    const contents = fsState.files.get(path);
    if (contents === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file '${path}'`), {
        code: 'ENOENT',
      });
    }
    return contents;
  },
  writeFile: async (path: string, contents: string) => {
    fsState.files.set(path, contents);
  },
  rm: async (path: string) => {
    for (const key of [...fsState.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        fsState.files.delete(key);
      }
    }
  },
}));

vi.mock('@dpg/schemas', () => {
  class SchemaFetchError extends Error {
    constructor(input: { url: string; status?: number; statusText?: string; cause?: unknown }) {
      super(`Failed to fetch schema from ${input.url}`);
      this.name = 'SchemaFetchError';
    }
  }

  class fetchSchema {
    private readonly url: string;

    constructor(url: string) {
      this.url = url;
      fetchedUrls.push(url);
    }

    async getSchema() {
      return getSchemaMock(this.url);
    }
  }

  return {
    fetchSchema,
    SchemaFetchError,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getDomainItemSchema: (...args: any[]) => getDomainItemSchemaMock(...args),
  };
});

vi.mock('@dpg/database', () => ({
  items: {
    item_type: 'items.item_type',
    item_schema_url: 'items.item_schema_url',
    item_network: 'items.item_network',
    item_domain: 'items.item_domain',
    item_instance_url: 'items.item_instance_url',
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('drizzle-orm', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: (...conditions: any[]) => ({ op: 'and', conditions }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: (left: any, right: any) => ({ op: 'eq', left, right }),
}));

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(dbState.rows);
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    selectDistinct: (selection: unknown) => {
      dbState.lastSelection = selection;
      return {
        from: () => ({
          // `cacheReferencedItemSchemas` awaits `.from(...)` directly while
          // `getItemSchemasForInstance` chains `.where(...)`, so this has to be
          // both a thenable and a builder. BOTH then-callbacks are forwarded —
          // dropping `rej` would hang a rejected query until the test timeout.
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            nextRows().then(res, rej),
          where: (condition: unknown) => {
            dbState.lastWhere = condition;
            return nextRows();
          },
        }),
      };
    },
  },
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigs: () => getNetworkConfigs(),
  refreshNetworkConfigs: () => refreshNetworkConfigs(),
}));

vi.mock('@/consent_configs', () => ({
  refreshConsentConfigs: () => refreshConsentConfigs(),
}));

// --- imports under test (after the mocks) ----------------------------------
import { SchemaFetchError, type NetworkConfigDocument } from '@dpg/schemas';
import {
  buildNetworkItemSchemaUrl,
  clearNetworkSchemaCache,
  getCachedSchemaForItemType,
  getCachedSchemas,
  getConfiguredNetworkSchemas,
  getItemSchemasForInstance,
  getOrFetchSchemaByUrl,
  hasCachedSchemaUrl,
  refreshConsumedSchemas,
} from '@/network_schema_cache';

const CACHE_ROOT = join(tmpdir(), 'dpg-network-schema-cache');
const SCHEMA_DIR = join(CACHE_ROOT, 'schemas');
const INDEX_FILE = join(CACHE_ROOT, 'index.json');

type IndexEntry = {
  cache_key: string;
  kind: string;
  network?: string;
  brand?: string;
  domain?: string;
  item_type?: string;
  instance_url?: string;
  schema_url?: string;
  source: string;
  cached_at: string;
  file_name: string;
};

function readIndexFromFakeFs(): { updated_at: string; entries: IndexEntry[] } {
  const raw = fsState.files.get(INDEX_FILE);
  if (!raw) throw new Error('index.json was not written');
  return JSON.parse(raw) as { updated_at: string; entries: IndexEntry[] };
}

/** Seed the fake disk directly so cache-hit paths can be tested in isolation. */
function seedCacheEntry(
  entry: Partial<IndexEntry> & { cache_key: string; kind: string },
  schema: Record<string, unknown>
) {
  const existing = fsState.files.get(INDEX_FILE);
  const index = existing
    ? (JSON.parse(existing) as { updated_at: string; entries: IndexEntry[] })
    : { updated_at: new Date(0).toISOString(), entries: [] as IndexEntry[] };
  const fileName = `${entry.cache_key}.json`;
  index.entries.push({
    source: 'inline',
    cached_at: new Date().toISOString(),
    file_name: fileName,
    ...entry,
  } as IndexEntry);
  fsState.files.set(INDEX_FILE, JSON.stringify(index, null, 2));
  fsState.files.set(join(SCHEMA_DIR, fileName), JSON.stringify(schema, null, 2));
}

function makeNetworkConfig(
  overrides: Partial<{
    id: string;
    source_url: string | undefined;
    domains: Array<{ id: string; item_schemas: Record<string, Record<string, unknown>> }>;
    instances: Array<{
      domain_id: string;
      instance_url: string;
      custom_item_schema_urls: Record<string, string>;
    }>;
  }> = {}
): NetworkConfigDocument {
  return {
    id: 'yellow_dot',
    source_url: 'https://cdn.example.com/networks/yellow_dot.json',
    domains: [
      {
        id: 'student',
        item_schemas: { 'profile_1.0': { title: 'student profile' } },
      },
    ],
    instances: [],
    ...overrides,
  } as unknown as NetworkConfigDocument;
}

beforeEach(() => {
  fsState.files.clear();
  fsState.mkdirCalls.length = 0;
  fetchedUrls.length = 0;
  dbState.failWith = null;
  dbState.rows = [];
  dbState.lastWhere = null;
  dbState.lastSelection = null;
  vi.clearAllMocks();
  getSchemaMock.mockImplementation((url: string) => ({ fetched_from: url }));
  getDomainItemSchemaMock.mockImplementation(() => ({
    resolved: 'domain-item-schema',
  }));
  getNetworkConfigs.mockResolvedValue([]);
  refreshNetworkConfigs.mockResolvedValue([]);
  refreshConsentConfigs.mockResolvedValue([]);
});

describe('buildNetworkItemSchemaUrl', () => {
  it('returns null when the network config has no source_url', () => {
    expect(
      buildNetworkItemSchemaUrl({
        networkConfig: makeNetworkConfig({ source_url: undefined }),
        domain: 'student',
        itemType: 'profile_1.0',
      })
    ).toBeNull();
  });

  it('appends an /item_schemas fragment to the source_url', () => {
    expect(
      buildNetworkItemSchemaUrl({
        networkConfig: makeNetworkConfig(),
        domain: 'student',
        itemType: 'profile_1.0',
      })
    ).toBe(
      'https://cdn.example.com/networks/yellow_dot.json#/item_schemas/yellow_dot/student/profile_1.0'
    );
  });

  it('URL-encodes each fragment segment and replaces a pre-existing hash', () => {
    const url = buildNetworkItemSchemaUrl({
      networkConfig: makeNetworkConfig({
        id: 'yellow dot',
        source_url: 'https://cdn.example.com/n.json?v=2#/old',
      }),
      domain: 'student/alt',
      itemType: 'profile 1.0',
    });

    expect(url).toBe(
      'https://cdn.example.com/n.json?v=2#/item_schemas/yellow%20dot/student%2Falt/profile%201.0'
    );
  });
});

describe('getCachedSchemas', () => {
  it('returns an empty list and creates the cache dir when nothing is cached', async () => {
    await expect(getCachedSchemas()).resolves.toEqual([]);
    expect(fsState.mkdirCalls).toContain(SCHEMA_DIR);
  });

  it('hydrates each index entry with its on-disk schema document', async () => {
    seedCacheEntry(
      { cache_key: 'a', kind: 'domain_item_schema', network: 'yellow_dot', domain: 'student', item_type: 'profile_1.0' },
      { title: 'profile' }
    );

    const cached = await getCachedSchemas();

    expect(cached).toHaveLength(1);
    expect(cached[0]?.schema).toEqual({ title: 'profile' });
    expect(cached[0]?.file_name).toBe('a.json');
  });

  it('filters by network, domain, itemType and schemaUrl', async () => {
    seedCacheEntry(
      {
        cache_key: 'match',
        kind: 'domain_item_schema',
        network: 'yellow_dot',
        domain: 'student',
        item_type: 'profile_1.0',
        schema_url: 'https://s/one.json',
      },
      { keep: true }
    );
    seedCacheEntry(
      {
        cache_key: 'other-network',
        kind: 'domain_item_schema',
        network: 'blue_dot',
        domain: 'student',
        item_type: 'profile_1.0',
        schema_url: 'https://s/one.json',
      },
      { keep: false }
    );
    seedCacheEntry(
      {
        cache_key: 'other-domain',
        kind: 'domain_item_schema',
        network: 'yellow_dot',
        domain: 'college',
        item_type: 'profile_1.0',
        schema_url: 'https://s/one.json',
      },
      { keep: false }
    );
    seedCacheEntry(
      {
        cache_key: 'other-item-type',
        kind: 'domain_item_schema',
        network: 'yellow_dot',
        domain: 'student',
        item_type: 'resume_1.0',
        schema_url: 'https://s/one.json',
      },
      { keep: false }
    );
    seedCacheEntry(
      {
        cache_key: 'other-url',
        kind: 'domain_item_schema',
        network: 'yellow_dot',
        domain: 'student',
        item_type: 'profile_1.0',
        schema_url: 'https://s/two.json',
      },
      { keep: false }
    );

    const cached = await getCachedSchemas({
      network: 'yellow_dot',
      domain: 'student',
      itemType: 'profile_1.0',
      schemaUrl: 'https://s/one.json',
    });

    expect(cached.map((entry) => entry.cache_key)).toEqual(['match']);
  });
});

describe('getOrFetchSchemaByUrl', () => {
  it('serves a cached schema without refetching', async () => {
    seedCacheEntry(
      { cache_key: 'cached', kind: 'item_schema_url', schema_url: 'https://s/profile.json' },
      { cached: true }
    );

    await expect(
      getOrFetchSchemaByUrl({ schemaUrl: 'https://s/profile.json' })
    ).resolves.toEqual({ cached: true });
    expect(fetchedUrls).toEqual([]);
  });

  it('fetches, caches as item_schema_url/remote, and serves the second call from disk', async () => {
    const first = await getOrFetchSchemaByUrl({
      schemaUrl: 'https://s/profile.json',
    });

    expect(first).toEqual({ fetched_from: 'https://s/profile.json' });
    expect(fetchedUrls).toEqual(['https://s/profile.json']);

    const entries = readIndexFromFakeFs().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'item_schema_url',
      source: 'remote',
      schema_url: 'https://s/profile.json',
    });
    expect(entries[0]?.cached_at).toEqual(expect.any(String));

    const second = await getOrFetchSchemaByUrl({
      schemaUrl: 'https://s/profile.json',
    });
    expect(second).toEqual({ fetched_from: 'https://s/profile.json' });
    expect(fetchedUrls).toEqual(['https://s/profile.json']);
  });

  it('records the caller-supplied kind and provenance fields on the index entry', async () => {
    await getOrFetchSchemaByUrl({
      schemaUrl: 'https://s/custom.json',
      kind: 'instance_custom_item_schema',
      network: 'yellow_dot',
      domain: 'student',
      itemType: 'profile_1.0',
      instanceUrl: 'https://inst.example.com',
    });

    expect(readIndexFromFakeFs().entries[0]).toMatchObject({
      kind: 'instance_custom_item_schema',
      network: 'yellow_dot',
      domain: 'student',
      item_type: 'profile_1.0',
      instance_url: 'https://inst.example.com',
      schema_url: 'https://s/custom.json',
      source: 'remote',
    });
  });

  it('resolves an /item_schemas fragment URL from the local network config instead of fetching', async () => {
    const networkConfig = makeNetworkConfig();
    getNetworkConfigs.mockResolvedValue([networkConfig]);
    const schemaUrl = buildNetworkItemSchemaUrl({
      networkConfig,
      domain: 'student',
      itemType: 'profile_1.0',
    }) as string;

    const schema = await getOrFetchSchemaByUrl({ schemaUrl });

    expect(schema).toEqual({ resolved: 'domain-item-schema' });
    expect(fetchedUrls).toEqual([]);
    expect(getDomainItemSchemaMock).toHaveBeenCalledWith(
      networkConfig,
      'student',
      'profile_1.0'
    );
  });

  it('falls back to a remote fetch when the fragment URL is not a configured network', async () => {
    getNetworkConfigs.mockResolvedValue([
      makeNetworkConfig({ source_url: 'https://cdn.example.com/networks/other.json' }),
    ]);
    const schemaUrl =
      'https://cdn.example.com/networks/yellow_dot.json#/item_schemas/yellow_dot/student/profile_1.0';

    await expect(getOrFetchSchemaByUrl({ schemaUrl })).resolves.toEqual({
      fetched_from: schemaUrl,
    });
    expect(getDomainItemSchemaMock).not.toHaveBeenCalled();
    expect(fetchedUrls).toEqual([schemaUrl]);
  });

  it('falls back to a remote fetch when the fragment is missing an item type', async () => {
    getNetworkConfigs.mockResolvedValue([makeNetworkConfig()]);
    const schemaUrl =
      'https://cdn.example.com/networks/yellow_dot.json#/item_schemas/yellow_dot/student';

    await getOrFetchSchemaByUrl({ schemaUrl });

    expect(getDomainItemSchemaMock).not.toHaveBeenCalled();
    expect(fetchedUrls).toEqual([schemaUrl]);
  });

  it('propagates a SchemaFetchError from the registry', async () => {
    getSchemaMock.mockImplementation(() =>
      Promise.reject(new SchemaFetchError({ url: 'https://s/broken.json', status: 500 }))
    );

    await expect(
      getOrFetchSchemaByUrl({ schemaUrl: 'https://s/broken.json' })
    ).rejects.toBeInstanceOf(SchemaFetchError);
    expect(fsState.files.has(INDEX_FILE)).toBe(false);
  });
});

describe('hasCachedSchemaUrl', () => {
  it('is true only for a schema_url present in the index', async () => {
    seedCacheEntry(
      { cache_key: 'x', kind: 'item_schema_url', schema_url: 'https://s/one.json' },
      {}
    );

    await expect(hasCachedSchemaUrl('https://s/one.json')).resolves.toBe(true);
    await expect(hasCachedSchemaUrl('https://s/two.json')).resolves.toBe(false);
  });
});

describe('clearNetworkSchemaCache', () => {
  it('removes the index and every cached schema document', async () => {
    await getOrFetchSchemaByUrl({ schemaUrl: 'https://s/profile.json' });
    expect(fsState.files.size).toBe(2);

    await clearNetworkSchemaCache();

    expect(fsState.files.size).toBe(0);
    await expect(getCachedSchemas()).resolves.toEqual([]);
    await expect(hasCachedSchemaUrl('https://s/profile.json')).resolves.toBe(false);
  });
});

describe('getConfiguredNetworkSchemas', () => {
  it('short-circuits on any cached entry and never re-reads the source config', async () => {
    seedCacheEntry(
      { cache_key: 'seeded', kind: 'network_config', network: 'yellow_dot' },
      { id: 'yellow_dot' }
    );

    const cached = await getConfiguredNetworkSchemas();

    expect(cached.map((entry) => entry.cache_key)).toEqual(['seeded']);
    expect(getNetworkConfigs).not.toHaveBeenCalled();
    expect(refreshConsentConfigs).not.toHaveBeenCalled();
  });

  it('caches network config, domain item schemas, instance custom schemas and consent configs on a cold cache', async () => {
    getNetworkConfigs.mockResolvedValue([
      makeNetworkConfig({
        domains: [
          {
            id: 'student',
            item_schemas: {
              'profile_1.0': { title: 'profile' },
              'resume_1.0': { title: 'resume' },
            },
          },
        ],
        instances: [
          {
            domain_id: 'student',
            instance_url: 'https://inst.example.com',
            custom_item_schema_urls: { 'profile_1.0': 'https://s/custom.json' },
          },
        ],
      }),
    ]);
    refreshConsentConfigs.mockResolvedValue([
      { network: 'yellow_dot', brand: 'blue', config: { version: '1.0' } },
      { network: 'yellow_dot', brand: null, config: { version: '1.1' } },
    ]);

    const result = await getConfiguredNetworkSchemas();

    const byKind = result.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind).toEqual({
      network_config: 1,
      domain_item_schema: 2,
      instance_custom_item_schema: 1,
      consent_config: 2,
    });

    // The instance custom schema is fetched remotely, domain schemas are inline.
    expect(fetchedUrls).toEqual(['https://s/custom.json']);
    const custom = result.find(
      (entry) => entry.kind === 'instance_custom_item_schema'
    );
    expect(custom).toMatchObject({
      source: 'remote',
      instance_url: 'https://inst.example.com',
      schema_url: 'https://s/custom.json',
    });
    expect(custom?.schema).toEqual({ fetched_from: 'https://s/custom.json' });

    // Domain item schemas carry the generated fragment schema_url.
    const profile = result.find(
      (entry) => entry.kind === 'domain_item_schema' && entry.item_type === 'profile_1.0'
    );
    expect(profile?.schema_url).toBe(
      'https://cdn.example.com/networks/yellow_dot.json#/item_schemas/yellow_dot/student/profile_1.0'
    );
    expect(profile?.schema).toEqual({ title: 'profile' });

    // A brand-less consent config is stored without a brand field.
    const brandless = result.find(
      (entry) => entry.kind === 'consent_config' && entry.brand === undefined
    );
    expect(brandless?.schema).toEqual({ version: '1.1' });
  });
});

describe('getCachedSchemaForItemType', () => {
  beforeEach(() => {
    seedCacheEntry(
      {
        cache_key: 'domain',
        kind: 'domain_item_schema',
        network: 'yellow_dot',
        domain: 'student',
        item_type: 'profile_1.0',
      },
      { source: 'domain' }
    );
    seedCacheEntry(
      {
        cache_key: 'instance',
        kind: 'instance_custom_item_schema',
        network: 'yellow_dot',
        domain: 'student',
        item_type: 'profile_1.0',
        instance_url: 'https://inst.example.com',
      },
      { source: 'instance' }
    );
  });

  it('prefers the instance custom schema when instanceUrl matches', async () => {
    await expect(
      getCachedSchemaForItemType({
        network: 'yellow_dot',
        domain: 'student',
        itemType: 'profile_1.0',
        instanceUrl: 'https://inst.example.com',
      })
    ).resolves.toEqual({ source: 'instance' });
  });

  it('falls back to the domain schema for an unknown instanceUrl', async () => {
    await expect(
      getCachedSchemaForItemType({
        network: 'yellow_dot',
        domain: 'student',
        itemType: 'profile_1.0',
        instanceUrl: 'https://other.example.com',
      })
    ).resolves.toEqual({ source: 'domain' });
  });

  it('uses the domain schema when no instanceUrl is given', async () => {
    await expect(
      getCachedSchemaForItemType({
        network: 'yellow_dot',
        domain: 'student',
        itemType: 'profile_1.0',
      })
    ).resolves.toEqual({ source: 'domain' });
  });

  it('returns null when nothing matches the item type', async () => {
    await expect(
      getCachedSchemaForItemType({
        network: 'yellow_dot',
        domain: 'student',
        itemType: 'unknown_1.0',
      })
    ).resolves.toBeNull();
  });
});

describe('getItemSchemasForInstance', () => {
  it('selects distinct item_type/item_schema_url filtered by network, domain and instance', async () => {
    dbState.rows = [
      { item_type: 'profile_1.0', item_schema_url: 'https://s/profile.json' },
    ];

    const rows = await getItemSchemasForInstance({
      network: 'yellow_dot',
      domain: 'student',
      instanceUrl: 'https://inst.example.com',
    });

    expect(rows).toEqual(dbState.rows);
    expect(dbState.lastSelection).toEqual({
      item_type: 'items.item_type',
      item_schema_url: 'items.item_schema_url',
    });
    expect(dbState.lastWhere).toEqual({
      op: 'and',
      conditions: [
        { op: 'eq', left: 'items.item_network', right: 'yellow_dot' },
        { op: 'eq', left: 'items.item_domain', right: 'student' },
        { op: 'eq', left: 'items.item_instance_url', right: 'https://inst.example.com' },
      ],
    });
  });

  it('propagates a database failure to the caller', async () => {
    dbState.failWith = new Error('connection terminated');

    await expect(
      getItemSchemasForInstance({
        network: 'yellow_dot',
        domain: 'student',
        instanceUrl: 'https://inst.example.com',
      })
    ).rejects.toThrow('connection terminated');
  });
});

describe('refreshConsumedSchemas', () => {
  it('rebuilds from refreshed configs and warms every referenced item_schema_url', async () => {
    refreshNetworkConfigs.mockResolvedValue([makeNetworkConfig()]);
    dbState.rows = [
      { item_schema_url: 'https://s/referenced.json' },
      { item_schema_url: null },
    ];

    const result = await refreshConsumedSchemas();

    expect(refreshNetworkConfigs).toHaveBeenCalledTimes(1);
    expect(getNetworkConfigs).not.toHaveBeenCalled();
    // Only the non-null referenced URL is fetched.
    expect(fetchedUrls).toEqual(['https://s/referenced.json']);
    expect(
      result.some((entry) => entry.schema_url === 'https://s/referenced.json')
    ).toBe(true);
    expect(result.some((entry) => entry.kind === 'network_config')).toBe(true);
  });

  it('skips a referenced schema whose fetch raises SchemaFetchError', async () => {
    dbState.rows = [
      { item_schema_url: 'https://s/broken.json' },
      { item_schema_url: 'https://s/ok.json' },
    ];
    getSchemaMock.mockImplementation((url: string) =>
      url === 'https://s/broken.json'
        ? Promise.reject(new SchemaFetchError({ url, status: 404 }))
        : { fetched_from: url }
    );

    const result = await refreshConsumedSchemas();

    expect(result.map((entry) => entry.schema_url)).toEqual(['https://s/ok.json']);
  });

  it('rethrows a non-SchemaFetchError raised while warming referenced schemas', async () => {
    dbState.rows = [{ item_schema_url: 'https://s/boom.json' }];
    getSchemaMock.mockImplementation(() =>
      Promise.reject(new TypeError('unexpected'))
    );

    await expect(refreshConsumedSchemas()).rejects.toThrow('unexpected');
  });
});
