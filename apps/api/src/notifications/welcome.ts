/**
 * Welcome notifications for a genuinely-new user.
 *
 * Provider-neutral on purpose: this is called from **both** identity paths, so
 * the two cannot send different things.
 *
 *   - better-auth — via the `afterUserCreate` hook in `routes/auth/create_auth.ts`
 *   - Keycloak    — from `createMirror` in `services/auth/provisioning.ts`
 *
 * It used to live inline in `packages/auth/src/config.ts`, inside the
 * `unifiedOtp` plugin's own `afterUserCreate`. That made it unreachable once
 * better-auth stopped running: `afterUserCreate` is a *unifiedOtp plugin option*
 * (consumed only at `packages/auth/plugins/unified_otp.ts:752`) and there are no
 * better-auth `databaseHooks`, so a user provisioned from a Keycloak token got no
 * welcome message at all. That is gap G1 of
 * `docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md`.
 *
 * **Never throws.** A welcome message is not worth failing a signup or a login
 * for — the same posture the better-auth hook had (it caught each send
 * separately so a failed SMS still let the email through).
 */

import { USER_WELCOME, type NotifyEvent } from '@dpg/notification';
import { E164_PATTERN } from '@dpg/schemas';

import { instance, notification, uiHostBindings } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { createCtaUrlResolver } from './brand';
import { sendBestEffort } from './send_event';

/** Just enough of the user to address them. */
export interface WelcomeRecipient {
  /** Keys the one-per-user idempotency key. */
  userId: string;
  name: string;
  email: string | null;
  phoneNumber: string | null;
}

/**
 * Minimal logger shape. `FastifyBaseLogger` satisfies this structurally, so the
 * Keycloak path can pass `request.log` straight through, while the better-auth
 * hook — which has no request context — can supply a console-backed adapter.
 */
export interface WelcomeLog {
  error: (details: Record<string, unknown>, message: string) => void;
}

/**
 * The welcome's idempotency key. Per user, not per occurrence: a welcome is
 * sent once in an account's life, so a repeat (a retried provisioning, a race
 * between two first logins) collapses into the first send.
 */
export function welcomeIdempotencyKey(userId: string): string {
  return `${USER_WELCOME}:${userId}`;
}

/**
 * Send the welcome for a newly-created user as ONE `user.welcome` event. The
 * notification service's policy (mode `all`) fans it out to the welcome email
 * and the WhatsApp welcome for whichever contact points `to` carries.
 *
 * A user with neither identifier, or an instance with no notification client
 * configured, is a silent no-op. When no site link can be resolved (no portal
 * for the signup domain and no FRONTEND_BASE_URL), the email cannot be built
 * (its `siteUrl` is required, F2-2): the email is dropped and WhatsApp still
 * goes; with no phone either, the send is skipped and logged.
 *
 * Awaited by both callers rather than fire-and-forget: better-auth awaited it,
 * so awaiting keeps first-login latency identical rather than quietly changing
 * it, and it keeps the behaviour testable.
 *
 * @param recipient - The user id, name and whichever identifiers the new user has.
 * @param log - Where send failures are reported. Never rethrown.
 */
export async function sendWelcomeNotifications(
  recipient: WelcomeRecipient,
  log: WelcomeLog,
  /**
   * The domain this account signed up into, when known. Picks the role's
   * welcome copy and the portal the welcome link points at on a split
   * deployment (#569). Undefined for an account with no parked signup domain
   * (migrated or admin-onboarded), which gets the generic copy and falls back
   * to FRONTEND_BASE_URL for the link.
   */
  domain?: string | null
): Promise<void> {
  const nc = getNotificationClient();
  if (!nc) return;

  const email = recipient.email || undefined;
  // NS accepts only E.164 (R14). A stored phone in any other form is left out
  // so the email still goes; the WhatsApp welcome is lost for that user.
  let phone = recipient.phoneNumber || undefined;
  if (phone && !E164_PATTERN.test(phone)) {
    log.error({ event_type: USER_WELCOME }, 'welcome: welcome_phone_dropped (not E.164)');
    phone = undefined;
  }
  if (!email && !phone) return;

  try {
    const siteUrl = domain
      ? createCtaUrlResolver({
          byDomain: uiHostBindings.byDomain,
          fallbackBaseUrl: notification.FRONTEND_BASE_URL,
        })(domain)
      : notification.FRONTEND_BASE_URL;

    if (!siteUrl && !phone) {
      log.error(
        { event_type: USER_WELCOME, domain: domain ?? null },
        'welcome: no site link resolvable (no portal for the domain, no FRONTEND_BASE_URL); welcome email skipped'
      );
      return;
    }

    const appName = instance.INSTANCE_NAME ?? 'DPG';
    const name = recipient.name || 'user';
    const event: NotifyEvent = {
      event_type: USER_WELCOME,
      domain: domain ?? null,
      // Without a site link only the WhatsApp welcome can be built.
      to: siteUrl ? { ...(email ? { email } : {}), ...(phone ? { phone } : {}) } : { phone },
      variables: {
        userName: name,
        appName,
        teamName: appName,
        ...(siteUrl ? { siteUrl } : {}),
        // The WhatsApp content template's only variable (F2-8).
        '1': name,
      },
      priority: 'urgent',
      idempotency_key: welcomeIdempotencyKey(recipient.userId),
    };

    await sendBestEffort(nc.send.bind(nc), event, (message, meta) =>
      log.error(meta, `welcome: ${message}`)
    );
  } catch (err) {
    log.error({ err }, 'welcome: could not send the welcome notification');
  }
}
