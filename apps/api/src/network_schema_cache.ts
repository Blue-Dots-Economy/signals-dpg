import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  fetchSchema,
  getDomainItemSchema,
  SchemaFetchError,
  type NetworkConfigDocument,
} from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { and, eq } from 'drizzle-orm';
import { getNetworkConfigs, refreshNetworkConfigs } from '@/network_configs';

type CachedSchemaKind =
  | 'network_config'
  | 'domain_item_schema'
  | 'instance_custom_item_schema'
  | 'item_schema_url';

type CachedSchemaIndexEntry = {
  cache_key: string;
  kind: CachedSchemaKind;
  network?: string;
  domain?: string;
  item_type?: string;
  instance_url?: string;
  schema_url?: string;
  source: 'inline' | 'remote';
  cached_at: string;
  file_name: string;
};

type CachedSchemaIndex = {
  updated_at: string;
  entries: CachedSchemaIndexEntry[];
};

type CachedSchemaResult = CachedSchemaIndexEntry & {
  schema: Record<string, unknown>;
};

const NETWORK_ITEM_SCHEMA_FRAGMENT_PREFIX = '/item_schemas';

const CACHE_ROOT = join(tmpdir(), 'dpg-network-schema-cache');
const SCHEMA_DIR = join(CACHE_ROOT, 'schemas');
const INDEX_FILE = join(CACHE_ROOT, 'index.json');

async function ensureCachePaths() {
  await mkdir(SCHEMA_DIR, { recursive: true });
}

async function readIndex(): Promise<CachedSchemaIndex> {
  await ensureCachePaths();

  try {
    const contents = await readFile(INDEX_FILE, 'utf8');
    return JSON.parse(contents) as CachedSchemaIndex;
  } catch {
    return {
      updated_at: new Date(0).toISOString(),
      entries: [],
    };
  }
}

async function writeIndex(index: CachedSchemaIndex) {
  await ensureCachePaths();
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

async function cacheSchemaDocument(
  entry: Omit<CachedSchemaIndexEntry, 'cached_at' | 'file_name'>,
  schema: Record<string, unknown>
): Promise<CachedSchemaIndexEntry> {
  const index = await readIndex();
  const fileName = `${entry.cache_key}.json`;
  const nextEntry: CachedSchemaIndexEntry = {
    ...entry,
    cached_at: new Date().toISOString(),
    file_name: fileName,
  };

  await writeFile(join(SCHEMA_DIR, fileName), JSON.stringify(schema, null, 2), 'utf8');

  const nextEntries = index.entries.filter(
    (existing) => existing.cache_key !== entry.cache_key
  );

  nextEntries.push(nextEntry);

  await writeIndex({
    updated_at: new Date().toISOString(),
    entries: nextEntries.sort((left, right) =>
      left.cache_key.localeCompare(right.cache_key)
    ),
  });

  return nextEntry;
}

function createCacheKey(parts: Array<string | undefined | null>) {
  return createHash('sha256')
    .update(parts.filter(Boolean).join('::'))
    .digest('hex');
}

async function readSchemaFile(fileName: string): Promise<Record<string, unknown>> {
  const contents = await readFile(join(SCHEMA_DIR, fileName), 'utf8');
  return JSON.parse(contents) as Record<string, unknown>;
}

async function cacheNetworkConfigSchemas(networkConfig: NetworkConfigDocument) {
  await cacheSchemaDocument(
    {
      cache_key: createCacheKey(['network_config', networkConfig.id]),
      kind: 'network_config',
      network: networkConfig.id,
      source: 'inline',
    },
    networkConfig as Record<string, unknown>
  );

  for (const domain of networkConfig.domains) {
    for (const [itemType, schema] of Object.entries(domain.item_schemas)) {
      await cacheSchemaDocument(
        {
          cache_key: createCacheKey([
            'domain_item_schema',
            networkConfig.id,
            domain.id,
            itemType,
          ]),
          kind: 'domain_item_schema',
          network: networkConfig.id,
          domain: domain.id,
          item_type: itemType,
          schema_url:
            buildNetworkItemSchemaUrl({
              networkConfig,
              domain: domain.id,
              itemType,
            }) ?? undefined,
          source: 'inline',
        },
        schema
      );
    }
  }

  for (const instance of networkConfig.instances) {
    for (const [itemType, schemaUrl] of Object.entries(
      instance.custom_item_schema_urls
    )) {
      const schema = (await new fetchSchema(schemaUrl).getSchema()) as Record<
        string,
        unknown
      >;

      await cacheSchemaDocument(
        {
          cache_key: createCacheKey([
            'instance_custom_item_schema',
            networkConfig.id,
            instance.domain_id,
            instance.instance_url,
            itemType,
            schemaUrl,
          ]),
          kind: 'instance_custom_item_schema',
          network: networkConfig.id,
          domain: instance.domain_id,
          item_type: itemType,
          instance_url: instance.instance_url,
          schema_url: schemaUrl,
          source: 'remote',
        },
        schema
      );
    }
  }
}

async function cacheReferencedItemSchemas() {
  const referencedSchemas = await db
    .selectDistinct({ item_schema_url: items.item_schema_url })
    .from(items);

  for (const entry of referencedSchemas) {
    if (!entry.item_schema_url) {
      continue;
    }

    try {
      await getOrFetchSchemaByUrl({
        schemaUrl: entry.item_schema_url,
      });
    } catch (err) {
      if (err instanceof SchemaFetchError) {
        continue;
      }

      throw err;
    }
  }
}

export async function refreshConsumedSchemas() {
  const networkConfigs = await refreshNetworkConfigs();

  for (const networkConfig of networkConfigs) {
    await cacheNetworkConfigSchemas(networkConfig);
  }

  await cacheReferencedItemSchemas();

  return getCachedSchemas();
}

export async function getCachedSchemas(filters?: {
  network?: string;
  domain?: string;
  itemType?: string;
  schemaUrl?: string;
}): Promise<CachedSchemaResult[]> {
  const index = await readIndex();
  const filteredEntries = index.entries.filter((entry) => {
    if (filters?.network && entry.network !== filters.network) {
      return false;
    }

    if (filters?.domain && entry.domain !== filters.domain) {
      return false;
    }

    if (filters?.itemType && entry.item_type !== filters.itemType) {
      return false;
    }

    if (filters?.schemaUrl && entry.schema_url !== filters.schemaUrl) {
      return false;
    }

    return true;
  });

  return Promise.all(
    filteredEntries.map(async (entry) => ({
      ...entry,
      schema: await readSchemaFile(entry.file_name),
    }))
  );
}

export async function getOrFetchSchemaByUrl(input: {
  schemaUrl: string;
  network?: string;
  domain?: string;
  itemType?: string;
  instanceUrl?: string;
  kind?: Extract<CachedSchemaKind, 'instance_custom_item_schema' | 'item_schema_url'>;
}) {
  const index = await readIndex();
  const cachedEntry = index.entries.find((entry) => entry.schema_url === input.schemaUrl);

  if (cachedEntry) {
    return readSchemaFile(cachedEntry.file_name);
  }

  const resolvedNetworkItemSchema = await resolveNetworkItemSchemaUrl(
    input.schemaUrl
  );
  const schema =
    resolvedNetworkItemSchema ??
    ((await new fetchSchema(input.schemaUrl).getSchema()) as Record<
      string,
      unknown
    >);

  await cacheSchemaDocument(
    {
      cache_key: createCacheKey([
        input.kind ?? 'item_schema_url',
        input.network,
        input.domain,
        input.itemType,
        input.instanceUrl,
        input.schemaUrl,
      ]),
      kind: input.kind ?? 'item_schema_url',
      network: input.network,
      domain: input.domain,
      item_type: input.itemType,
      instance_url: input.instanceUrl,
      schema_url: input.schemaUrl,
      source: 'remote',
    },
    schema
  );

  return schema;
}

export function buildNetworkItemSchemaUrl(input: {
  networkConfig: NetworkConfigDocument;
  domain: string;
  itemType: string;
}) {
  if (!input.networkConfig.source_url) {
    return null;
  }

  const url = new URL(input.networkConfig.source_url);
  url.hash = [
    NETWORK_ITEM_SCHEMA_FRAGMENT_PREFIX,
    encodeURIComponent(input.networkConfig.id),
    encodeURIComponent(input.domain),
    encodeURIComponent(input.itemType),
  ].join('/');

  return url.toString();
}

async function resolveNetworkItemSchemaUrl(schemaUrl: string) {
  const parsedUrl = new URL(schemaUrl);

  if (!parsedUrl.hash.startsWith(`#${NETWORK_ITEM_SCHEMA_FRAGMENT_PREFIX}/`)) {
    return null;
  }

  const [network, domain, itemType] = parsedUrl.hash
    .slice(1)
    .split('/')
    .slice(2)
    .map((entry) => decodeURIComponent(entry));

  if (!network || !domain || !itemType) {
    return null;
  }

  const networkConfigs = await getNetworkConfigs();
  const networkConfig = networkConfigs.find(
    (entry) =>
      entry.id === network &&
      entry.source_url &&
      withoutHash(entry.source_url) === withoutHash(schemaUrl)
  );

  if (!networkConfig) {
    return null;
  }

  return getDomainItemSchema(networkConfig, domain, itemType);
}

function withoutHash(input: string) {
  const url = new URL(input);
  url.hash = '';
  return url.toString();
}

export async function getConfiguredNetworkSchemas() {
  const cachedSchemas = await getCachedSchemas();

  if (cachedSchemas.length > 0) {
    return cachedSchemas;
  }

  const networkConfigs = await getNetworkConfigs();

  for (const networkConfig of networkConfigs) {
    await cacheNetworkConfigSchemas(networkConfig);
  }

  return getCachedSchemas();
}

export async function getCachedSchemaForItemType(input: {
  network: string;
  domain: string;
  itemType: string;
  instanceUrl?: string;
}) {
  const customEntries = await getCachedSchemas({
    network: input.network,
    domain: input.domain,
    itemType: input.itemType,
  });

  if (input.instanceUrl) {
    const matchingInstanceSchema = customEntries.find(
      (entry) =>
        entry.kind === 'instance_custom_item_schema' &&
        entry.instance_url === input.instanceUrl
    );

    if (matchingInstanceSchema) {
      return matchingInstanceSchema.schema;
    }
  }

  const matchingDomainSchema = customEntries.find(
    (entry) => entry.kind === 'domain_item_schema'
  );

  return matchingDomainSchema?.schema ?? null;
}

export async function hasCachedSchemaUrl(schemaUrl: string) {
  const index = await readIndex();
  return index.entries.some((entry) => entry.schema_url === schemaUrl);
}

export async function getItemSchemasForInstance(input: {
  network: string;
  domain: string;
  instanceUrl: string;
}) {
  return db
    .selectDistinct({
      item_type: items.item_type,
      item_schema_url: items.item_schema_url,
    })
    .from(items)
    .where(
      and(
        eq(items.item_network, input.network),
        eq(items.item_domain, input.domain),
        eq(items.item_instance_url, input.instanceUrl)
      )
    );
}
