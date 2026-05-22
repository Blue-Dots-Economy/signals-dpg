import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization } from '../../../db/postgres/schema/auth.js';
import { apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { getDomainItemSchema } from '@dpg/schemas';

interface SchemaLike {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

export interface ResolvedSchema {
  schema: SchemaLike;
  network: string;
  domain: string;
  item_type: string;
}

const ITEM_TYPE = 'profile_1.0';

/**
 * Resolves the JSON Schema used to score profile completion + derive
 * missing-field tags for a given aggregator. Lookup priority:
 *
 *   1. Per-aggregator override via `organization.metadata` JSON:
 *      `{ network, domain }` — only used when BOTH parse cleanly as strings.
 *   2. First binding from `apiConfig.served_domains`.
 *
 * `item_type` is hardcoded to 'profile_1.0' for the pilot. If aggregators
 * later need a different item type per network, lift this into a per-
 * aggregator override (likely the same `organization.metadata` blob).
 *
 * Throws (via @dpg/schemas) if the resolved (network, domain, item_type)
 * triple has no schema configured — recompute treats that as fatal so the
 * dashboard doesn't silently fall back to "everyone is 0% complete".
 */
export const get_schema_for_aggregator = async (
  aggregator_id: string,
): Promise<ResolvedSchema> => {
  // 1. Per-aggregator override via organization.metadata.
  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, aggregator_id))
    .limit(1);

  let network: string | undefined;
  let domain: string | undefined;

  if (org?.metadata) {
    try {
      const meta = JSON.parse(org.metadata) as Record<string, unknown>;
      if (typeof meta.network === 'string') network = meta.network;
      if (typeof meta.domain === 'string') domain = meta.domain;
    } catch {
      // Ignore malformed metadata; fall back to served-domains.
    }
  }

  // 2. Fall back to first served binding.
  if (!network || !domain) {
    const first = apiConfig.served_domains?.[0];
    if (!first?.network || !first?.domain) {
      throw new Error(
        'no served_domains configured; cannot resolve schema for metrics',
      );
    }
    network ??= first.network;
    domain ??= first.domain;
  }

  // 3. Resolve the schema via the cached network config.
  //    `getDomainItemSchema` throws if the domain or item_type is missing.
  const networkConfig = await getNetworkConfigById(network);
  const schema = getDomainItemSchema(networkConfig, domain, ITEM_TYPE) as SchemaLike;

  return { schema, network, domain, item_type: ITEM_TYPE };
};
