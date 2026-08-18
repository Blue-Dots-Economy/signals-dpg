/**
 * Shared, framework-agnostic helpers for the profile action flow (Apply/Connect
 * + match/instance routing). Extracted so the SAME rules live in one place
 * across every surface that initiates actions — the home-page browse (list +
 * map popup) and the public profile page. Keeping the interaction-matrix
 * flattening, instance-URL resolution, and open-action detection here prevents
 * the two call sites from drifting (a fix to gating or routing lands once).
 *
 * Pure functions only — no React, no I/O. Callers supply the network config,
 * the already-fetched actions, and the current API base URL.
 */
import type { DotActionSchema, DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';

/**
 * Every action a `sourceDomain` can initiate on a `targetDomain`, flattened
 * from the network's action/interaction matrix into `DotActionSchema[]`.
 * Returns an empty list when the network is unresolved.
 */
export function getActionsForDomain(
  network: DotNetworkSchema | null,
  sourceDomain: string,
  targetDomain: string,
): DotActionSchema[] {
  if (!network) return [];
  const actions: DotActionSchema[] = [];
  for (const [actionType, actionConfig] of Object.entries(network.actions ?? {})) {
    if (!actionConfig?.interactions) continue;
    const matching = actionConfig.interactions.filter(
      (i) => i.from_domain === sourceDomain && i.to_domain === targetDomain,
    );
    for (const interaction of matching) {
      actions.push({
        action_type: actionType,
        from_domain: interaction.from_domain,
        to_domain: interaction.to_domain,
        requirement_schema: interaction.requirement_schema,
        event_schema: interaction.event_schema,
        reveals_pii_on_status: interaction.reveals_pii_on_status,
      });
    }
  }
  return actions;
}

/**
 * Resolve the instance URL an item lives on:
 *   1. the item's own `item_instance_url`, when usable (not a localhost URL in a
 *      non-localhost deployment),
 *   2. else the network's per-domain instance config,
 *   3. else the current API base URL.
 * Single-instance today, so this typically returns the current origin.
 */
export function resolveTargetInstanceUrl(
  item: Item,
  network: DotNetworkSchema | null,
  currentApiUrl: string,
): string {
  if (item.item_instance_url) {
    const isLocalhost =
      item.item_instance_url.includes('localhost') ||
      item.item_instance_url.includes('127.0.0.1');
    const isProduction =
      !currentApiUrl.includes('localhost') && !currentApiUrl.includes('127.0.0.1');
    if (!isLocalhost || !isProduction) return item.item_instance_url;
  }
  if (network?.instances) {
    const instanceConfig = network.instances.find((i) => i.domain_id === item.item_domain);
    if (instanceConfig?.instance_url) return instanceConfig.instance_url;
  }
  return currentApiUrl;
}

/**
 * Action statuses that TERMINATE a source/target pair, freeing it for a new
 * action. A non-terminal action means one is already open, so the pair's
 * Apply/Connect CTA is disabled (#370/#422). The server cap is the real guard;
 * the UI check just pre-empts the click.
 */
export const OPEN_ACTION_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'completed',
  'cancelled',
  'rejected',
  'declined',
  'withdrawn',
]);

/** Minimal shape of an action row needed for open-action detection. */
export interface OpenActionRow {
  action_status: string;
  source_item_id: string;
  target_item_id: string;
}

/**
 * The set of item ids `activeProfileId` already has an OPEN (non-terminal)
 * action with, in either direction. Empty when there is no active profile.
 */
export function computeOpenActionItemIds(
  actions: readonly OpenActionRow[],
  activeProfileId: string | null,
): Set<string> {
  const set = new Set<string>();
  if (!activeProfileId) return set;
  for (const a of actions) {
    if (OPEN_ACTION_TERMINAL_STATUSES.has(a.action_status)) continue;
    if (a.source_item_id === activeProfileId) set.add(a.target_item_id);
    else if (a.target_item_id === activeProfileId) set.add(a.source_item_id);
  }
  return set;
}
