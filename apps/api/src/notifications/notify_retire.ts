import type { FastifyBaseLogger } from 'fastify';
import { ACTION_CANCELLED_BY_RETIRE } from '@dpg/notification';

import type { RetireCancelledCounterparty } from '@/services/items/retire_connections';
import { resolveNotifierConfig } from './notify_actions';
import { resolveOwnerEmail } from './resolve_owner';
import { sendBestEffort } from './send_event';

/**
 * Fire-and-forget notifier for the retire → counterparty notice (#418).
 *
 * Called from the lifecycle route AFTER the retire transaction commits, with
 * the counterparties whose open connections `cancelItemConnections` ended. For
 * each, resolves the (local) owner email and sends one
 * `action.cancelled_by_retire` event, with the counterparty's own domain, to
 * the notification service. Reuses the action-notifier config and the
 * owner-email lookup.
 *
 * Never throws and never blocks the route (mirrors `dispatchActionNotifications`).
 * No-op when notifications aren't configured. A counterparty with no local user
 * (owner-less, or hosted on another instance) resolves to no email and is
 * skipped — this is the v1 "local counterparties only" rule.
 */
export async function dispatchRetireCancelNotifications(
  counterparties: readonly RetireCancelledCounterparty[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (counterparties.length === 0) return;
  const config = resolveNotifierConfig();
  if (!config) return;

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

      // The counterparty's own domain — this mail goes to THEM, so it links
      // to their portal, not the retiring owner's (#569). A missing URL would
      // leave the only call to action broken, so skip this counterparty.
      const ctaUrl = config.resolveCtaUrl(cp.domain);
      if (!ctaUrl) {
        log.warn(
          { actionId: cp.actionId, domain: cp.domain },
          'retire notification skipped: no CTA url for counterparty domain',
        );
        continue;
      }

      await sendBestEffort(
        config.send,
        {
          event_type: ACTION_CANCELLED_BY_RETIRE,
          domain: cp.domain,
          to: { email },
          variables: { ctaUrl, teamName: config.teamName },
          priority: 'normal',
          idempotency_key: `retire_cancel:${cp.actionId}:${cp.ownerUserId}`,
        },
        (message, meta) => log.warn(meta, message),
        { actionId: cp.actionId },
      );
    } catch (err) {
      log.warn(
        { err, actionId: cp.actionId },
        'retire counterparty notification failed',
      );
    }
  }
}
