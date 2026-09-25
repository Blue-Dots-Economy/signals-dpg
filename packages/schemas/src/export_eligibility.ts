/**
 * Bulk-export eligibility (#769), dependency-free so the browser bundle can
 * import it (`@dpg/schemas/export_eligibility`) without the DB-bound barrel.
 * The api and the UI share this one function, so "which download controls
 * show" and "what the server will export" cannot drift.
 */

/** Structural subset of a network config this module reads. */
export interface ExportEligibilityConfig {
  id: string;
  actions: Record<
    string,
    {
      interactions: ReadonlyArray<{
        from_network?: string;
        from_domain: string;
        to_network?: string;
        to_domain: string;
        reveals_pii_on_status?: readonly string[];
        export?: { requester_domains: readonly string[] };
      }>;
    }
  >;
}

/** A counterparty (network, domain) a requester may bulk-export. */
export interface ExportableCounterparty {
  network: string;
  domain: string;
}

/**
 * Every counterparty (network, domain) a requester in `requesterDomain` may
 * bulk-export, across all actions of the network.
 *
 * Drives which download controls the UI shows — none, one, or one per
 * counterparty type — without a round-trip. Sorted by network then domain,
 * deduplicated. A same-domain interaction (provider→provider) yields that
 * domain as the counterparty.
 */
export function getExportableCounterparties(
  networkConfig: ExportEligibilityConfig,
  requesterDomain: string
): ExportableCounterparty[] {
  const found = new Map<string, ExportableCounterparty>();
  const add = (network: string, domain: string) =>
    found.set(`${network}::${domain}`, { network, domain });

  for (const action of Object.values(networkConfig.actions ?? {})) {
    for (const interaction of action.interactions ?? []) {
      if (!interaction.export?.requester_domains.includes(requesterDomain)) continue;
      if (interaction.from_domain === requesterDomain) {
        add(interaction.to_network ?? networkConfig.id, interaction.to_domain);
      }
      if (interaction.to_domain === requesterDomain) {
        add(interaction.from_network ?? networkConfig.id, interaction.from_domain);
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.network.localeCompare(b.network) || a.domain.localeCompare(b.domain)
  );
}

/**
 * Action statuses a requester in `requesterDomain` may export: the union of
 * `reveals_pii_on_status` over every interaction whose export block lists
 * that domain. Sorted, deduplicated.
 *
 * Exporting is only useful where the counterparty's details are revealed, so
 * the reveal statuses are the export statuses — adding a status to a
 * network's `reveals_pii_on_status` (e.g. `completed`) makes it exportable
 * with no code change.
 */
export function getExportableStatuses(
  networkConfig: ExportEligibilityConfig,
  requesterDomain: string
): string[] {
  const statuses = new Set<string>();
  for (const action of Object.values(networkConfig.actions ?? {})) {
    for (const interaction of action.interactions ?? []) {
      if (!interaction.export?.requester_domains.includes(requesterDomain)) continue;
      for (const s of interaction.reveals_pii_on_status ?? []) statuses.add(s);
    }
  }
  return [...statuses].sort((a, b) => a.localeCompare(b));
}
