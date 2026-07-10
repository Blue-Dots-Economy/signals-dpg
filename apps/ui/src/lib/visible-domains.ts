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
 * - Directory networks: a network that defines NO interaction edges at all
 *   (e.g. orange_dot — a single `practitioner` domain, no connect/apply flows)
 *   has no to_domains to derive from, which would leave the portal with nothing
 *   to browse (visibleDomains=[] → the browse fetch is skipped entirely). Such a
 *   network is a flat directory, so every one of its own domains is browsable.
 *   This only triggers when there are zero edges network-wide; a viewer that
 *   merely has no outgoing edge in an interaction network still sees nothing.
 */
export function computeVisibleDomains(
  network: DotNetworkSchema,
  viewerDomain: string | null,
): DotNetworkDomain[] {
  const actions = network.actions ?? {};
  const hasAnyInteraction = Object.values(actions).some(
    (action) => (action.interactions ?? []).length > 0,
  );

  // Directory network (no interaction edges) → browse every domain.
  if (!hasAnyInteraction) {
    return network.domains;
  }

  const toDomains = new Set<string>();
  for (const action of Object.values(actions)) {
    for (const interaction of action.interactions ?? []) {
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
