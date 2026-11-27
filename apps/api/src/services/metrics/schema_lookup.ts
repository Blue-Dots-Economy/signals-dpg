import { getNetworkConfigById } from '@/network_configs';
import { getDomainItemSchema } from '@dpg/schemas';

export interface JSONSchemaLike {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

/**
 * The JSON Schema for a (network, domain, item_type). Throws if the triple has
 * no schema configured.
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
