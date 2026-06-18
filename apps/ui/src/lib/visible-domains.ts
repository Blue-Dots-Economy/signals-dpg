import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';

/**
 * Browseable domains for a given viewer.
 *
 * Visibility derives from the network's interaction edges
 * (actions.*.interactions[], each a from_domain -> to_domain pair): a viewer
 * sees domain Y iff an interaction exists where from = the viewer's own domain
 * and to = Y — i.e. you browse exactly what you can initiate toward.
 *
 * - viewerDomain null: no domain identity, so every browseable domain (every
 *   distinct to_domain) is returned — today's legacy behavior.
 * - Cross-network edges (from_network other than this network) are ignored.
 */
export function computeVisibleDomains(
  network: DotNetworkSchema,
  viewerDomain: string | null,
): DotNetworkDomain[] {
  const toDomains = new Set<string>();
  for (const action of Object.values(network.actions)) {
    for (const interaction of action.interactions) {
      if (viewerDomain) {
        const fromNetwork = interaction.from_network ?? network.id;
        if (interaction.from_domain !== viewerDomain || fromNetwork !== network.id) {
          continue;
        }
      }
      toDomains.add(interaction.to_domain);
    }
  }
  return network.domains.filter((d) => toDomains.has(d.id));
}
