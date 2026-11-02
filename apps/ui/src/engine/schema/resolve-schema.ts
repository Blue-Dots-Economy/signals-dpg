import type { RJSFSchema } from '@rjsf/utils';
import { setCachedSchema, getCachedSchema } from './schema-loader';

/**
 * Resolves a JSON Pointer (e.g., "#/definitions/student") within a root document.
 */
export function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#/')) {
    throw new Error(`Invalid JSON Pointer: ${pointer}`);
  }

  if (pointer === '#') return doc;

  const segments = pointer
    .slice(2)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));

  let current: unknown = doc;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      throw new Error(`Cannot resolve pointer ${pointer}: null/undefined at segment "${segment}"`);
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Invalid array index "${segment}" in pointer ${pointer}`);
      }
      current = current[index];
    } else if (typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (!(segment in obj)) {
        throw new Error(`Key "${segment}" not found in pointer ${pointer}`);
      }
      current = obj[segment];
    } else {
      throw new Error(`Cannot resolve pointer ${pointer}: primitive at segment "${segment}"`);
    }
  }

  return current;
}

/**
 * Unwraps a DotProfileSchema wrapper (`schema_type: "profile"` plus `schema`)
 * to its inner JSON Schema; anything else is returned as-is.
 */
export function extractSchema(result: unknown): RJSFSchema {
  if (
    typeof result === 'object' &&
    result !== null &&
    'schema_type' in result &&
    (result as Record<string, unknown>).schema_type === 'profile' &&
    'schema' in result
  ) {
    return (result as Record<string, unknown>).schema as RJSFSchema;
  }
  return result as RJSFSchema;
}

/**
 * Resolves one $ref string: a local JSON Pointer ("#/…", needs rootDocument),
 * a `refMap` entry, or a relative path / absolute URL (fetched). Results are
 * cached via schema-loader.
 */
export async function resolveRefString(
  ref: string,
  options?: { baseUrl?: string; rootDocument?: unknown; refMap?: Record<string, unknown> }
): Promise<unknown> {
  const cached = getCachedSchema(ref);
  if (cached) return cached;

  let resolved: unknown;

  if (ref.startsWith('#/')) {
    if (!options?.rootDocument) {
      throw new Error(`Cannot resolve local ref "${ref}" without rootDocument`);
    }
    resolved = resolveJsonPointer(options.rootDocument, ref);
  } else if (options?.refMap && ref in options.refMap) {
    resolved = options.refMap[ref];
  } else {
    let url: string;
    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      url = ref;
    } else if (options?.baseUrl) {
      url = `${options.baseUrl}/${ref.replace(/^\.\//, '')}`;
    } else {
      url = new URL(ref, window.location.origin).href;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to resolve $ref "${ref}": ${response.status}`);
    }
    resolved = await response.json();
  }

  setCachedSchema(ref, resolved as RJSFSchema);
  return resolved;
}

/**
 * Returns a deep copy of the network object with every external
 * `{ $ref: "..." }` resolved and DotProfileSchema wrappers unwrapped. `refMap`
 * supplies pre-loaded schemas; `baseUrl` resolves relative paths.
 */
export async function resolveNetworkRefs(
  network: unknown,
  options?: { baseUrl?: string; refMap?: Record<string, unknown> }
): Promise<unknown> {
  if (typeof network !== 'object' || network === null) {
    return network;
  }

  if (Array.isArray(network)) {
    return Promise.all(
      network.map((item) => resolveNetworkRefs(item, options))
    );
  }

  const obj = network as Record<string, unknown>;

  // Local JSON Pointers ("#/...") are left for RJSF, which resolves
  // $defs/definitions at render time.
  if (typeof obj.$ref === 'string') {
    if (obj.$ref.startsWith('#/') || obj.$ref === '#') {
      return obj;
    }
    const raw = await resolveRefString(obj.$ref, {
      baseUrl: options?.baseUrl,
      rootDocument: network,
      refMap: options?.refMap,
    });
    const schema = extractSchema(raw);
    return resolveNetworkRefs(schema, options);
  }

  const entries = await Promise.all(
    Object.entries(obj).map(async ([key, value]) => [
      key,
      await resolveNetworkRefs(value, options),
    ])
  );

  return Object.fromEntries(entries);
}

export async function resolveRefs(
  schema: RJSFSchema,
  baseUrl?: string
): Promise<RJSFSchema> {
  const resolved = { ...schema };

  if (resolved.$ref) {
    const refTarget = await resolveRef(resolved.$ref, baseUrl);
    const { $ref, ...rest } = resolved;
    return resolveRefs({ ...refTarget, ...rest }, baseUrl);
  }

  if (resolved.properties) {
    const props: Record<string, RJSFSchema> = {};
    for (const [key, prop] of Object.entries(resolved.properties)) {
      props[key] = await resolveRefs(prop as RJSFSchema, baseUrl);
    }
    resolved.properties = props;
  }

  if (resolved.items && typeof resolved.items === 'object') {
    resolved.items = await resolveRefs(resolved.items as RJSFSchema, baseUrl);
  }

  if (resolved.allOf) {
    resolved.allOf = await Promise.all(
      resolved.allOf.map((s) => resolveRefs(s as RJSFSchema, baseUrl))
    );
  }

  if (resolved.oneOf) {
    resolved.oneOf = await Promise.all(
      resolved.oneOf.map((s) => resolveRefs(s as RJSFSchema, baseUrl))
    );
  }

  if (resolved.anyOf) {
    resolved.anyOf = await Promise.all(
      resolved.anyOf.map((s) => resolveRefs(s as RJSFSchema, baseUrl))
    );
  }

  return resolved;
}

async function resolveRef(
  $ref: string,
  baseUrl?: string
): Promise<RJSFSchema> {
  if ($ref.startsWith('#/')) {
    throw new Error(
      `Local JSON Pointer resolution not yet supported: ${$ref}`
    );
  }

  const cached = getCachedSchema($ref);
  if (cached) return cached as RJSFSchema;

  const url = $ref.startsWith('http')
    ? $ref
    : baseUrl
      ? `${baseUrl}/${$ref}`
      : $ref;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to resolve $ref ${url}: ${response.status}`);
  }

  const schema: RJSFSchema = await response.json();
  setCachedSchema($ref, schema);
  return schema;
}

export function mergeAllOf(schemas: RJSFSchema[]): RJSFSchema {
  const merged: RJSFSchema = {
    type: 'object',
    properties: {},
    required: [],
  };

  for (const schema of schemas) {
    if (schema.properties) {
      merged.properties = {
        ...merged.properties,
        ...schema.properties,
      };
    }
    if (schema.required) {
      merged.required = [...(merged.required ?? []), ...schema.required];
    }
    if (schema.description) {
      merged.description = schema.description;
    }
  }

  if (merged.required && merged.required.length === 0) {
    delete merged.required;
  }

  return merged;
}
