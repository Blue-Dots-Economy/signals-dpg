import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';

/**
 * Browseable domains for a viewer, derived from the network's interaction
 * edges: a viewer sees domain Y iff an interaction goes from their own domain
 * to Y (you browse what you can initiate toward).
 *
 * - viewerDomain null: every distinct `to_domain` is returned.
 * - Cross-network edges (another `from_network`) are ignored.
 * - A network with no interaction edges at all (a flat directory such as
 *   orange_dot) browses every one of its domains; otherwise nothing would be
 *   browsable. A viewer who merely lacks an outgoing edge still sees nothing.
 */
export function computeVisibleDomains(
  network: DotNetworkSchema,
  viewerDomain: string | null,
): DotNetworkDomain[] {
  const actions = network.actions ?? {};
  const hasAnyInteraction = Object.values(actions).some(
    (action) => (action.interactions ?? []).length > 0,
  );

  // Directory network (no interaction edges): browse every domain.
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
