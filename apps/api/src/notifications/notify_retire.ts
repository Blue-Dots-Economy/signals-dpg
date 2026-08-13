import type { FastifyBaseLogger } from 'fastify';

import type { RetireCancelledCounterparty } from '@/services/items/retire_connections';
import { resolveNetworkBrandName, resolveNotifierConfig } from './notify_actions';
import { resolveOwnerEmail } from './resolve_owner';

/**
 * Fire-and-forget notifier for the retire → counterparty email (#418).
 *
 * Called from the lifecycle route AFTER the retire transaction commits, with
 * the counterparties whose open connections `cancelItemConnections` ended. For
 * each, resolves the (local) owner email and sends one branded email using the
 * dedicated `retire.cancel` email case. Reuses the action-notifier config,
 * brand resolution, owner-email lookup, and the central email sender.
 *
 * Never throws and never blocks the route (mirrors `dispatchActionNotifications`).
 * No-op when notifications aren't configured. A counterparty with no local user
 * (owner-less, or hosted on another instance) resolves to no email and is
 * skipped — this is the v1 "local counterparties only" rule.
 *
 * @param brandNetwork the retired item's network id, for the brand sign-off.
 */
export async function dispatchRetireCancelNotifications(
  counterparties: readonly RetireCancelledCounterparty[],
  brandNetwork: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (counterparties.length === 0) return;
  const config = resolveNotifierConfig();
  if (!config) return;

  const brandName = await resolveNetworkBrandName(brandNetwork);

  // Dedupe: one notice per counterparty per connection.
  const seen = new Set<string>();

  for (const cp of counterparties) {
    try {
      if (!cp.ownerUserId) continue;
      const key = `${cp.actionId}:${cp.ownerUserId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const email = await resolveOwnerEmail(cp.ownerUserId);
      if (!email) continue;

      await config.sender.dispatchEmail({
        caseId: 'retire.cancel',
        to: email,
        fromName: brandName,
        network: cp.network,
        ctaUrl: config.ctaUrl,
        dedupeId: `retire_cancel:${cp.actionId}:${cp.ownerUserId}`,
        log: (message, meta) => log.warn(meta ?? {}, message),
      });
    } catch (err) {
      log.warn(
        { err, actionId: cp.actionId },
        'retire counterparty notification failed',
      );
    }
  }
}
