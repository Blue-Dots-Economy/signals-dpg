import type { FastifyBaseLogger } from 'fastify';

import type { RetireCancelledCounterparty } from '@/services/items/retire_connections';
import { resolveNetworkBrandName, resolveNotifierConfig } from './notify_actions';
import { resolveOwnerEmail } from './resolve_owner';

/**
 * Sends the `retire.cancel` email to each counterparty whose open connection
 * `cancelItemConnections` ended. Call after the retire transaction commits.
 *
 * Never throws. No-op when notifications are not configured. Counterparties
 * with no local user (owner-less or on another instance) are skipped.
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

      // Links to the counterparty's own portal; without a URL the CTA would be
      // `<a href="">`, so skip.
      const ctaUrl = config.resolveCtaUrl(cp.domain);
      if (!ctaUrl) {
        log.warn(
          { actionId: cp.actionId, domain: cp.domain },
          'retire notification skipped: no CTA url for counterparty domain',
        );
        continue;
      }

      await config.sender.dispatchEmail({
        caseId: 'retire.cancel',
        to: email,
        fromName: brandName,
        network: cp.network,
        ctaUrl,
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
