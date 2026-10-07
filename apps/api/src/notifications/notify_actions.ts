import type { FastifyBaseLogger } from 'fastify';

import { instance, notification, uiHostBindings } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { getNotificationClient } from '@/utils/notificationClient';

import type { NotificationEvent, NotificationPlan } from './build_notifications';
import { createCtaUrlResolver, resolveBrandName } from './brand';
import { createDirectDispatcher } from './dispatcher';
import { resolveRecipientRole } from './action_copy';
import { resolveOwnerEmail, resolveProviderServiceName } from './resolve_owner';
import type { SendEvent } from './send_event';

export interface NotifierConfig {
  /** Posts one event to the notification service. */
  send: SendEvent;
  resolveCtaUrl: (domain: string) => string | undefined;
  /**
   * "Team <name>" sign-off sent as `variables.teamName` on every action and
   * item event: the operating org (INSTANCE_NAME, e.g. "EkStep"), not the
   * network display name.
   */
  teamName: string;
}

/**
 * The network's display name (e.g. "Blue Dot"), falling back to INSTANCE_NAME
 * when the network config has none. Sent as `networkName` (and the
 * `aggregatorOrg` fallback) on the aggregator-onboarding event. Best-effort —
 * never throws.
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
 * Memoised notifier config (event sender + CTA resolver + sign-off). `null`
 * when notifications aren't configured: action and item events need the
 * notification-service client plus at least one URL source (UI_HOST_BINDINGS
 * or FRONTEND_BASE_URL). The sender identity (From name and address) is the
 * notification service's deployment config, so no from-email is needed here.
 * Shared with the retire and item-lifecycle notifiers.
 */
export function resolveNotifierConfig(): NotifierConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const nc = getNotificationClient();
  const frontendBaseUrl = notification.FRONTEND_BASE_URL;
  const hasAnyUrl =
    !!frontendBaseUrl || Object.keys(uiHostBindings.byDomain).length > 0;

  // Gate on "some URL source exists", not on the scalar alone: a split
  // deployment configures UI_HOST_BINDINGS and may leave FRONTEND_BASE_URL
  // unset, and requiring the scalar would silently stop EVERY action email
  // rather than degrade one link (#569).
  if (!nc || !hasAnyUrl) {
    cachedConfig = null;
    return cachedConfig;
  }

  cachedConfig = {
    send: (event) => nc.send(event),
    resolveCtaUrl: createCtaUrlResolver({
      byDomain: uiHostBindings.byDomain,
      fallbackBaseUrl: frontendBaseUrl,
    }),
    teamName: instance.INSTANCE_NAME || 'DPG',
  };
  return cachedConfig;
}

/**
 * Fire-and-forget entry point used by the action route seams. Resolves
 * recipients and sends one `action.<actionType>.<shape>` event per local
 * owner side to the notification service, which owns the copy and channel.
 * Never throws and never blocks the route. No-op when notifications are not
 * configured (missing NS client or any URL source).
 */
export async function dispatchActionNotifications(
  event: NotificationEvent,
  log: FastifyBaseLogger,
): Promise<void> {
  const config = resolveNotifierConfig();
  if (!config) return;

  const dispatcher = createDirectDispatcher({
    send: config.send,
    resolveEmail: resolveOwnerEmail,
    // Seeker-facing copy uses the provider's service name; provider-facing
    // copy keeps the seeker generic. Pass the counterparty's network so the
    // item lookup can prune to its partition.
    resolveCounterpartyName: async (plan: NotificationPlan) =>
      resolveRecipientRole(plan.counterpartyDomain) === 'provider'
        ? resolveProviderServiceName(plan.counterpartyItemId, plan.counterpartyNetwork)
        : null,
    teamName: config.teamName,
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
