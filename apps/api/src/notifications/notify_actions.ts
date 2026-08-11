import type { FastifyBaseLogger } from 'fastify';

import { instance, notification } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { getNotificationClient } from '@/utils/notificationClient';

import type { NotificationEvent, NotificationPlan } from './build_notifications';
import { buildCtaUrl, resolveBrandName } from './brand';
import { createDirectDispatcher } from './dispatcher';
import type { NotifyRequest } from './dispatcher';
import { resolveRecipientRole } from './action_copy';
import { resolveOwnerEmail, resolveProviderServiceName } from './resolve_owner';

export interface NotifierConfig {
  notify: (req: NotifyRequest) => Promise<unknown>;
  fromEmail: string;
  replyTo: string;
  ctaUrl: string;
}

/**
 * Brand display name for the sign-off ("Team {name}"): the action network's
 * `display_name` (e.g. "Blue Dot"), falling back to INSTANCE_NAME when the
 * network config has none. Best-effort — never throws. Reused by the retire
 * notifier (#418).
 */
export async function resolveNetworkBrandName(networkId: string): Promise<string> {
  try {
    const config = await getNetworkConfigById(networkId);
    return resolveBrandName({
      networkDisplayName: config.display_name,
      instanceName: instance.INSTANCE_NAME,
    });
  } catch {
    return resolveBrandName({ instanceName: instance.INSTANCE_NAME });
  }
}

// `undefined` = not yet resolved; `null` = resolved and not configured.
let cachedConfig: NotifierConfig | null | undefined;

/**
 * Memoised notifier config (NS client + from/reply/cta). `null` when
 * notifications aren't configured. Shared with the retire notifier (#418) so
 * both read the same config + reset. */
export function resolveNotifierConfig(): NotifierConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const nc = getNotificationClient();
  const fromEmail = notification.NOTIFICATION_FROM_EMAIL;
  const frontendBaseUrl = notification.FRONTEND_BASE_URL;

  if (!nc || !fromEmail || !frontendBaseUrl) {
    cachedConfig = null;
    return cachedConfig;
  }

  cachedConfig = {
    notify: (req) => nc.notify(req),
    fromEmail,
    replyTo: notification.NOTIFICATION_REPLY_TO ?? fromEmail,
    ctaUrl: buildCtaUrl(frontendBaseUrl),
  };
  return cachedConfig;
}

/**
 * Fire-and-forget entry point used by the action route seams. Resolves
 * recipients, renders branded HTML, and posts to the notification service.
 * Never throws and never blocks the route. No-op when notifications are not
 * configured (missing NS client / from-email / frontend base URL).
 */
export async function dispatchActionNotifications(
  event: NotificationEvent,
  log: FastifyBaseLogger,
): Promise<void> {
  const config = resolveNotifierConfig();
  if (!config) return;

  // Brand name is per-network (the action's network display_name).
  const brandName = await resolveNetworkBrandName(event.target.network);

  const dispatcher = createDirectDispatcher({
    notify: config.notify,
    resolveEmail: resolveOwnerEmail,
    // Seeker-facing copy uses the provider's service name; provider-facing
    // copy keeps the seeker generic. Use the same provider-like classification
    // as the copy selection so the two never drift, and pass the counterparty's
    // network so the item lookup can prune to its partition.
    resolveCounterpartyName: async (plan: NotificationPlan) =>
      resolveRecipientRole(plan.counterpartyDomain) === 'provider'
        ? resolveProviderServiceName(plan.counterpartyItemId, plan.counterpartyNetwork)
        : null,
    brand: {
      brandName,
      fromEmail: config.fromEmail,
      replyTo: config.replyTo,
      ctaUrl: config.ctaUrl,
    },
    log: (message, meta) => log.warn(meta ?? {}, message),
    onSkip: (reason) => log.info({ reason }, 'action notification skipped'),
  });

  await dispatcher.dispatch(event);
}

/** Test-only: reset the memoised config. */
export function resetActionNotifierConfigForTests(): void {
  cachedConfig = undefined;
}
