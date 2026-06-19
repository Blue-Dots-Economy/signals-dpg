import type { FastifyBaseLogger } from 'fastify';

import { instance, notification } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import type { NotificationEvent, NotificationPlan } from './build_notifications';
import { buildCtaUrl, resolveBrandName } from './brand';
import { createDirectDispatcher } from './dispatcher';
import type { NotifyRequest } from './dispatcher';
import { resolveOwnerEmail, resolveOwnerName } from './resolve_owner';

interface NotifierConfig {
  notify: (req: NotifyRequest) => Promise<unknown>;
  brand: {
    brandName: string;
    fromEmail: string;
    replyTo: string;
    ctaUrl: string;
  };
}

// `undefined` = not yet resolved; `null` = resolved and not configured.
let cachedConfig: NotifierConfig | null | undefined;

function resolveConfig(): NotifierConfig | null {
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
    brand: {
      brandName: resolveBrandName({ instanceName: instance.INSTANCE_NAME }),
      fromEmail,
      replyTo: notification.NOTIFICATION_REPLY_TO ?? fromEmail,
      ctaUrl: buildCtaUrl(frontendBaseUrl),
    },
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
  const config = resolveConfig();
  if (!config) return;

  const dispatcher = createDirectDispatcher({
    notify: config.notify,
    resolveEmail: resolveOwnerEmail,
    resolveCounterpartyName: async (plan: NotificationPlan) =>
      plan.revealCounterpartyName && plan.counterpartyUserId
        ? resolveOwnerName(plan.counterpartyUserId)
        : null,
    brand: config.brand,
    log: (message, meta) => log.warn(meta ?? {}, message),
    onSkip: (reason) => log.info({ reason }, 'action notification skipped'),
  });

  await dispatcher.dispatch(event);
}

/** Test-only: reset the memoised config. */
export function resetActionNotifierConfigForTests(): void {
  cachedConfig = undefined;
}
