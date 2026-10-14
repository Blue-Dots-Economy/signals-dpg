import type { NetworkConfigDocument } from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';

/**
 * Per-request memo over `getNetworkConfigById`: each network loads at most
 * once, and a failed load is remembered as `null` (reported once through
 * `onError`) so callers can fail closed without retrying per row.
 */
export function memoizeNetworkConfigs(
  onError: (err: unknown, network: string) => void,
  known?: { id: string; config: NetworkConfigDocument }
): (network: string) => Promise<NetworkConfigDocument | null> {
  const cache = new Map<string, NetworkConfigDocument | null>();
  if (known) cache.set(known.id, known.config);
  return async (network) => {
    if (cache.has(network)) return cache.get(network) ?? null;
    try {
      const cfg = await getNetworkConfigById(network);
      cache.set(network, cfg);
      return cfg;
    } catch (err) {
      onError(err, network);
      cache.set(network, null);
      return null;
    }
  };
}
