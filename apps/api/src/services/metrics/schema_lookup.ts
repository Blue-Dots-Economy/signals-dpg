import { getNetworkConfigById } from '@/network_configs';
import { getDomainItemSchema } from '@dpg/schemas';

export interface JSONSchemaLike {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

/**
 * Resolve the JSON Schema for a given (network, domain, item_type).
 * Plan B's recompute calls this per item — one aggregator can host
 * items across multiple (network, domain, item_type) triples. Throws if
 * the triple has no schema configured.
 */
export const get_item_schema = async (
  network: string,
  domain: string,
  item_type: string,
): Promise<JSONSchemaLike> => {
  const networkConfig = await getNetworkConfigById(network);
  const schema = getDomainItemSchema(networkConfig, domain, item_type);
  return schema as JSONSchemaLike;
};
