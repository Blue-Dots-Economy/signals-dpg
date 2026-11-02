import type { FastifyBaseLogger } from 'fastify';

import { instance, notification, uiHostBindings } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { getNotificationClient } from '@/utils/notificationClient';

import type { NotificationEvent, NotificationPlan } from './build_notifications';
import { createCtaUrlResolver, resolveBrandName } from './brand';
import { createDirectDispatcher } from './dispatcher';
import { resolveRecipientRole } from './action_copy';
import { createEmailSender, getInstanceDefaultNetwork } from './email/dispatch_email';
import type { EmailSender } from './email/dispatch_email';
import { getEmailMessages } from './email/messages';
import { resolveOwnerEmail, resolveProviderServiceName } from './resolve_owner';

export interface NotifierConfig {
  sender: EmailSender;
  resolveCtaUrl: (domain: string) => string | undefined;
}

/**
 * Brand display name: the network's `display_name`, else INSTANCE_NAME.
 * Never throws.
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
 * Memoised email sender and CTA resolver for action, retire and item-lifecycle
 * emails. `null` unless a notification client, NOTIFICATION_FROM_EMAIL and at
 * least one URL source (UI_HOST_BINDINGS or FRONTEND_BASE_URL) are configured.
 */
export function resolveNotifierConfig(): NotifierConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const nc = getNotificationClient();
  const fromEmail = notification.NOTIFICATION_FROM_EMAIL;
  const frontendBaseUrl = notification.FRONTEND_BASE_URL;
  const hasAnyUrl =
    !!frontendBaseUrl || Object.keys(uiHostBindings.byDomain).length > 0;

  // A split deployment may set only UI_HOST_BINDINGS, so FRONTEND_BASE_URL alone is not required.
  if (!nc || !fromEmail || !hasAnyUrl) {
    cachedConfig = null;
    return cachedConfig;
  }

  cachedConfig = {
    sender: createEmailSender({
      notify: (req) => nc.notify(req),
      getMessages: getEmailMessages,
      fromEmail,
      defaultReplyTo: notification.NOTIFICATION_REPLY_TO ?? fromEmail,
      defaultNetwork: getInstanceDefaultNetwork(),
      teamName: instance.INSTANCE_NAME || 'DPG',
      log: (message, meta) => console.warn(message, meta ?? {}),
    }),
    resolveCtaUrl: createCtaUrlResolver({
      byDomain: uiHostBindings.byDomain,
      fallbackBaseUrl: frontendBaseUrl,
    }),
  };
  return cachedConfig;
}

/**
 * Entry point for action emails. Callers `void` it. No-op when notifications
 * are not configured.
 */
export async function dispatchActionNotifications(
  event: NotificationEvent,
  log: FastifyBaseLogger,
): Promise<void> {
  const config = resolveNotifierConfig();
  if (!config) return;

  const brandName = await resolveNetworkBrandName(event.target.network);

  const dispatcher = createDirectDispatcher({
    sendEmail: (args) => config.sender.dispatchEmail(args),
    resolveEmail: resolveOwnerEmail,
    // Seeker-facing copy names the provider's service; provider-facing copy
    // keeps the seeker generic. The network lets the lookup prune to one partition.
    resolveCounterpartyName: async (plan: NotificationPlan) =>
      resolveRecipientRole(plan.counterpartyDomain) === 'provider'
        ? resolveProviderServiceName(plan.counterpartyItemId, plan.counterpartyNetwork)
        : null,
    brand: { brandName },
    resolveCtaUrl: config.resolveCtaUrl,
    log: (message, meta) => log.warn(meta ?? {}, message),
    onSkip: (reason) => log.info({ reason }, 'action notification skipped'),
  });

  await dispatcher.dispatch(event);
}

/** Test-only: reset the memoised config. */
export function resetActionNotifierConfigForTests(): void {
  cachedConfig = undefined;
}
