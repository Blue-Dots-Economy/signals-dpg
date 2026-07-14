import type {
  DotProfileSchema,
  DotNetworkSchema,
  DotActionSchema,
  SchemaInput,
} from '../types';
import type { RJSFSchema } from '@rjsf/utils';

type JsonSchema = RJSFSchema | DotProfileSchema | DotNetworkSchema | DotActionSchema;

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — aligns with the config staleTime tier

interface CacheEntry {
  schema: JsonSchema;
  expiresAt: number;
}

const schemaCache = new Map<string, CacheEntry>();

/** Returns a live (non-expired) entry's schema, deleting it if expired. */
function readFresh(key: string): JsonSchema | undefined {
  const entry = schemaCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    schemaCache.delete(key);
    return undefined;
  }
  return entry.schema;
}

function getCacheKey(input: SchemaInput): string | null {
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null && 'url' in input) return input.url;
  if (typeof input === 'object' && input !== null && 'api' in input) {
    const base = input.baseUrl ?? '';
    return `${base}${input.api}`;
  }
  return null;
}

export async function loadSchema(input: SchemaInput): Promise<JsonSchema> {
  const cacheKey = getCacheKey(input);

  if (cacheKey) {
    const fresh = readFresh(cacheKey);
    if (fresh !== undefined) return fresh;
  }

  let schema: JsonSchema;

  if (typeof input === 'string') {
    schema = await fetchSchema(input);
  } else if (typeof input === 'object' && input !== null && 'url' in input) {
    schema = await fetchSchema(input.url);
  } else if (typeof input === 'object' && input !== null && 'api' in input) {
    const base = input.baseUrl ?? '';
    schema = await fetchSchema(`${base}${input.api}`);
  } else {
    schema = input;
  }

  if (cacheKey) {
    schemaCache.set(cacheKey, { schema, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS });
  }

  return schema;
}

async function fetchSchema(url: string): Promise<JsonSchema> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch schema from ${url}: ${response.status}`);
  }
  return response.json();
}

export function clearSchemaCache(): void {
  schemaCache.clear();
}

export function getCachedSchema(key: string): JsonSchema | undefined {
  return readFresh(key);
}

export function setCachedSchema(key: string, schema: JsonSchema): void {
  schemaCache.set(key, { schema, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS });
}
