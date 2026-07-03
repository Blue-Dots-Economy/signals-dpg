/**
 * Shared helpers for `*.integration.test.ts` suites under `apps/api/src/routes/v1/`.
 *
 * Each integration suite seeds users + items + actions against a real DB, asserts
 * the framework behaviour, and tears down. The seeding shape depends on the local
 * `SERVED_DOMAINS` configuration; hard-coding `blue_dot/seeker` (or similar) makes
 * suites fragile across dev / CI environments. These helpers resolve bindings
 * from `apiConfig` at runtime and generate a minimal-valid `item_state` from the
 * resolved JSON schema, so suites pass against any served network.
 *
 * Why a shared module rather than inline copies per suite:
 *   - The generator + binding resolver are non-trivial (pattern handling, minItems
 *     recursion, private-field stripping) and duplicating them risks drift.
 *   - Both `participant.integration.test.ts` and the action-side suites need the
 *     same shape; one canonical implementation is easier to extend and review.
 */
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Minimal-valid item_state generator
// ---------------------------------------------------------------------------

/**
 * Walks `schema.required` and produces the smallest valid object that
 * satisfies each required property's type constraints. Optional fields
 * are intentionally omitted to keep payloads deterministic.
 *
 * Supported leaf types: enum, string (with `pattern` for digit-only patterns),
 * integer, number, boolean, array (recursive on `items` for `minItems > 0`),
 * object (recurses on the nested schema). Encountering oneOf / anyOf / $ref
 * throws immediately so the test fails loudly rather than emitting
 * silently-invalid data.
 */
export function generateMinimalItemState(
  schema: Record<string, unknown>,
  opts?: { stringPrefix?: string },
): Record<string, unknown> {
  const required = schema.required;
  if (!Array.isArray(required)) {
    return {};
  }

  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    return {};
  }

  const prefix = opts?.stringPrefix ?? 'int';
  const suffix = randomBytes(4).toString('hex');
  const result: Record<string, unknown> = {};

  for (const name of required as string[]) {
    const prop = properties[name];
    if (!prop) {
      throw new Error(
        `generateMinimalItemState: required property "${name}" missing from schema.properties`,
      );
    }
    result[name] = pickValue(prop, name, prefix, suffix);
  }

  return result;
}

function pickValue(
  prop: Record<string, unknown>,
  name: string,
  prefix: string,
  suffix: string,
): unknown {
  if ('oneOf' in prop || 'anyOf' in prop || '$ref' in prop) {
    throw new Error(
      `generateMinimalItemState: property "${name}" uses oneOf/anyOf/$ref which is not supported — ` +
        `provide a concrete schema or extend the generator.`,
    );
  }

  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[0];
  }

  const type = prop.type as string | undefined;

  switch (type) {
    case 'string': {
      if (typeof prop.pattern === 'string') {
        return generateStringForPattern(prop.pattern, name);
      }
      const minLen = typeof prop.minLength === 'number' ? prop.minLength : 1;
      const raw = `${prefix}-${name}-${suffix}`;
      return raw.length >= minLen ? raw : raw.padEnd(minLen, 'x');
    }
    case 'integer':
    case 'number': {
      const min = typeof prop.minimum === 'number' ? prop.minimum : undefined;
      const max = typeof prop.maximum === 'number' ? prop.maximum : undefined;
      const base = min ?? 1;
      if (max !== undefined && base > max) return max;
      return base;
    }
    case 'boolean':
      return true;
    case 'array': {
      const minItems = typeof prop.minItems === 'number' ? prop.minItems : 0;
      if (minItems === 0) return [];
      const items = prop.items as Record<string, unknown> | undefined;
      if (!items) {
        throw new Error(
          `generateMinimalItemState: array "${name}" requires minItems ${minItems} ` +
            `but declares no items schema`,
        );
      }
      const values: unknown[] = [];
      for (let i = 0; i < minItems; i++) {
        values.push(pickValue(items, `${name}[${i}]`, prefix, suffix));
      }
      return values;
    }
    case 'object': {
      const nested = prop as Record<string, unknown>;
      return generateMinimalItemState(nested, { stringPrefix: prefix });
    }
    default:
      throw new Error(
        `generateMinimalItemState: property "${name}" has unsupported type "${type ?? '(none)'}". ` +
          `Extend the generator to handle this type.`,
      );
  }
}

// Generates a string that satisfies a JSON Schema `pattern`. Recognises only
// the digit-only patterns currently in use across the bundled network configs
// (`^[0-9]{N}$`, `^\d{N}$`, `^[0-9]+$`, `^\d+$`). Other patterns throw with a
// pointer to extend this helper rather than producing silently-invalid data.
function generateStringForPattern(pattern: string, name: string): string {
  const fixedDigits =
    pattern.match(/^\^?\[0-9\]\{(\d+)\}\$?$/) ??
    pattern.match(/^\^?\\d\{(\d+)\}\$?$/);
  if (fixedDigits) {
    return '0'.repeat(Number(fixedDigits[1]));
  }
  if (/^\^?\[0-9\]\+\$?$/.test(pattern) || /^\^?\\d\+\$?$/.test(pattern)) {
    return '0123456789';
  }
  throw new Error(
    `generateMinimalItemState: property "${name}" has pattern "${pattern}" which is not recognised. ` +
      `Extend generateStringForPattern to handle it, or override the fixture for this test.`,
  );
}

/**
 * Strips properties marked `"private": true` from a state object. Used when
 * asserting that an item's persisted `item_state` matches what the test sent,
 * since private fields are stored as type-aware masks (PR #37) and won't equal
 * their input. Public fields round-trip verbatim.
 */
export function nonPrivateFields(
  schema: Record<string, unknown>,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return { ...state };
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(state)) {
    if (properties[name]?.private !== true) {
      result[name] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Served-domain binding resolver
// ---------------------------------------------------------------------------

export type ResolvedBinding = {
  network: string;
  domain: string;
  item_type: string;
  schema: Record<string, unknown>;
};

export type ResolvedBindings = {
  primary: ResolvedBinding;
  secondary: ResolvedBinding | null;
};

/**
 * Resolves the first and (optionally) second `served_domains` binding from
 * `apiConfig`, looks up each binding's first declared `item_type` in the
 * network config, and returns a tuple suitable for driving test seeding.
 *
 * Throws loudly if `SERVED_DOMAINS` is empty or a binding's domain declares no
 * `item_schemas` — silent skip would let an under-configured CI run pretend to
 * be green.
 */
export async function resolveBindings(): Promise<ResolvedBindings> {
  const { apiConfig } = await import('@/config');
  const { getNetworkConfigById } = await import('@/network_configs');

  if (apiConfig.served_domains.length === 0) {
    throw new Error(
      'resolveBindings: SERVED_DOMAINS is empty. ' +
        'Configure at least one "network/domain" binding to run this suite.',
    );
  }

  async function resolveSingle(
    network: string,
    domain: string,
  ): Promise<ResolvedBinding> {
    const networkConfig = await getNetworkConfigById(network);
    const domainConfig = networkConfig.domains?.find((d) => d.id === domain);
    if (!domainConfig) {
      throw new Error(
        `resolveBindings: domain "${domain}" not found in network config for "${network}". ` +
          `Available domains: ${(networkConfig.domains ?? []).map((d) => d.id).join(', ')}`,
      );
    }

    const itemSchemas = domainConfig.item_schemas;
    if (!itemSchemas || Object.keys(itemSchemas).length === 0) {
      throw new Error(
        `resolveBindings: domain "${domain}" in network "${network}" declares no item_schemas. ` +
          `Cannot derive a test fixture without at least one schema.`,
      );
    }

    const item_type = Object.keys(itemSchemas)[0];
    const schema = itemSchemas[item_type] as Record<string, unknown>;

    return { network, domain, item_type, schema };
  }

  const primaryBinding = apiConfig.served_domains[0];
  const primary = await resolveSingle(
    primaryBinding.network,
    primaryBinding.domain,
  );

  const secondaryBinding = apiConfig.served_domains.find(
    (b) => b.key !== primaryBinding.key,
  );
  const secondary = secondaryBinding
    ? await resolveSingle(secondaryBinding.network, secondaryBinding.domain)
    : null;

  return { primary, secondary };
}

// ---------------------------------------------------------------------------
// Action interaction consent helper
// ---------------------------------------------------------------------------

/**
 * Resolves the consent metadata declared on a specific (action_type, from→to)
 * interaction in a network config, plus the list of reveal-statuses. Returns
 * `null` when no matching interaction is configured.
 *
 * Tests calling `/api/v1/action/perform` against an interaction that declares
 * `reveals_pii_on_status` must include a `consent: { acknowledged: true, version }`
 * block in the body, else the route returns 422 CONSENT_REQUIRED.
 * This helper resolves the interaction metadata without each suite
 * re-implementing the lookup.
 */
export async function resolveInteractionConsent(input: {
  actionType: string;
  fromNetwork: string;
  fromDomain: string;
  fromItemType?: string;
  toNetwork: string;
  toDomain: string;
  toItemType?: string;
}): Promise<{
  reveals_pii_on_status: string[];
} | null> {
  const { getNetworkConfigById } = await import('@/network_configs');
  const networkConfig = await getNetworkConfigById(input.toNetwork);
  const actionDef = networkConfig.actions?.[input.actionType];
  if (!actionDef) return null;

  const interaction = (actionDef.interactions ?? []).find((i) => {
    const fromNet = i.from_network ?? networkConfig.id;
    const toNet = i.to_network ?? networkConfig.id;
    const fromItems = i.from_items ?? [];
    const toItems = i.to_items ?? [];
    return (
      fromNet === input.fromNetwork &&
      i.from_domain === input.fromDomain &&
      (fromItems.length === 0 ||
        (input.fromItemType !== undefined && fromItems.includes(input.fromItemType))) &&
      toNet === input.toNetwork &&
      i.to_domain === input.toDomain &&
      (toItems.length === 0 ||
        (input.toItemType !== undefined && toItems.includes(input.toItemType)))
    );
  });
  if (!interaction) return null;

  return {
    reveals_pii_on_status: interaction.reveals_pii_on_status ?? [],
  };
}

/**
 * Builds a consent acknowledgement body with the new version-based shape.
 * Returns `{ acknowledged: true, version }` unconditionally (always version 1
 * by default). Callers include this when the interaction declares
 * `reveals_pii_on_status` (i.e. consent is required), else omit it.
 */
export function consentAck(
  version = 1,
): { acknowledged: true; version: number } {
  return { acknowledged: true as const, version };
}
