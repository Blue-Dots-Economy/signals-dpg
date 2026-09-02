import type { ApiClient } from './api-client.js';
import { RUN_ID } from './identities.js';

/** A served network/domain binding as returned by `GET /`. */
export interface ServedDomain {
  network: string;
  domain: string;
  key?: string;
}

export interface RootInfo {
  service: string;
  status: string;
  served_domains: ServedDomain[];
  network_config_source?: string;
}

/** A resolved binding + its JSON schema, enough to build a valid item. */
export interface Binding {
  network: string;
  domain: string;
  item_type: string;
  schema: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  private?: boolean;
  /** Marks a geocoded location field (e.g. "primary"); needs a real place name. */
  location?: string;
  $ref?: string;
  oneOf?: unknown[];
  anyOf?: unknown[];
}

interface SchemaEntry {
  network: string;
  domain: string;
  item_type: string;
  schema_url?: string;
  schema: JsonSchema;
}

/** Read the target's served domains from the unauthenticated root endpoint. */
export async function getRoot(api: ApiClient): Promise<RootInfo> {
  const res = await api.get<RootInfo>('/');
  if (res.status !== 200 || !res.body?.served_domains) {
    throw new Error(`[e2e] GET / did not return served_domains (status ${res.status}). Body: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/**
 * Resolve a usable binding + schema for a given "network/domain" key. If
 * `domainKey` is omitted, the first served binding is used. Mirrors the
 * integration helper `resolveBindings()` but over HTTP.
 */
export async function resolveBinding(api: ApiClient, domainKey?: string): Promise<Binding> {
  const root = await getRoot(api);
  const served = root.served_domains;
  if (served.length === 0) throw new Error('[e2e] target serves no domains');

  const picked = domainKey
    ? served.find((s) => `${s.network}/${s.domain}` === domainKey)
    : served[0];
  if (!picked) {
    throw new Error(`[e2e] served domain "${domainKey}" not found; target serves: ${served.map((s) => `${s.network}/${s.domain}`).join(', ')}`);
  }

  const res = await api.get<SchemaEntry[]>(`/api/v1/network/schemas?network=${encodeURIComponent(picked.network)}&domain=${encodeURIComponent(picked.domain)}`);
  const entries = Array.isArray(res.body) ? res.body : [];
  const entry = entries.find((e) => e.network === picked.network && e.domain === picked.domain) ?? entries[0];
  if (!entry?.schema || !entry.item_type) {
    throw new Error(`[e2e] no schema for ${picked.network}/${picked.domain} (status ${res.status})`);
  }
  return { network: picked.network, domain: picked.domain, item_type: entry.item_type, schema: entry.schema };
}

let fieldSeq = 0;

/**
 * Build the smallest valid value for a schema property. Mirrors
 * `generateMinimalItemState`'s per-type rules so items pass server validation.
 * Throws on $ref/oneOf/anyOf (unsupported — same as the integration helper).
 */
function minimalValue(name: string, s: JsonSchema): unknown {
  if (s.$ref || s.oneOf || s.anyOf) {
    throw new Error(`[e2e] schema property "${name}" uses $ref/oneOf/anyOf — unsupported by the minimal builder`);
  }
  if (s.enum && s.enum.length > 0) return s.enum[0];

  // Geocoded location fields need a real, resolvable place — a junk string can't
  // geocode, leaving the profile incomplete and stuck in draft.
  if (s.location) return 'Bengaluru, Karnataka, India';

  switch (s.type) {
    case 'string': {
      let v: string;
      if (s.pattern) {
        const digitFixed = /^\^?\[0-9\]\{(\d+)\}\$?$/.exec(s.pattern) ?? /^\^?\\d\{(\d+)\}\$?$/.exec(s.pattern);
        if (digitFixed) {
          v = '0'.repeat(Number(digitFixed[1]));
        } else if (/^\^?(\[0-9\]|\\d)\+\$?$/.test(s.pattern)) {
          v = '0123456789';
        } else {
          v = `int-${name}-${RUN_ID}${(fieldSeq++).toString(36)}`;
        }
      } else {
        v = `int-${name}-${RUN_ID}${(fieldSeq++).toString(36)}`;
      }
      if (s.minLength && v.length < s.minLength) v = v.padEnd(s.minLength, '0');
      return v;
    }
    case 'integer':
    case 'number': {
      let n = s.minimum ?? 1;
      if (s.maximum !== undefined && n > s.maximum) n = s.maximum;
      return n;
    }
    case 'boolean':
      return true;
    case 'array': {
      const count = s.minItems ?? 0;
      if (count === 0 || !s.items) return [];
      return Array.from({ length: count }, () => minimalValue(`${name}[]`, s.items as JsonSchema));
    }
    case 'object':
      return buildMinimalItemState(s);
    default:
      // untyped / unknown → a harmless string
      return `int-${name}-${RUN_ID}${(fieldSeq++).toString(36)}`;
  }
}

/** Walk `schema.required` and produce the minimal valid object. Optional fields omitted. */
export function buildMinimalItemState(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const required = schema.required ?? [];
  const props = schema.properties ?? {};
  for (const key of required) {
    const propSchema = props[key];
    if (!propSchema) continue;
    out[key] = minimalValue(key, propSchema);
  }
  return out;
}
