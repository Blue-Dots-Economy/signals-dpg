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

import { instance, notification, uiHostBindings } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { createCtaUrlResolver } from './brand';
import { getDefaultEmailSender } from './email/dispatch_email';
import { resolveRecipientRole } from './action_copy';

/** Just enough of the user to address them. */
export interface WelcomeRecipient {
  name: string;
  email: string | null;
  /**
   * Carried for callers' convenience but not used today: the welcome is
   * email-only. There is no phone channel (WhatsApp is planned, not supported),
   * so a phone-only user gets no welcome message.
   */
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
 * Send the welcome email for a newly-created user.
 *
 * A failed send is swallowed. A user with no email, or an instance with no
 * notification client configured, is a silent no-op.
 *
 * Awaited by both callers rather than fire-and-forget: better-auth awaited it,
 * so awaiting keeps first-login latency identical rather than quietly changing
 * it, and it keeps the behaviour testable.
 *
 * @param recipient - Name plus whichever identifiers the new user has.
 * @param log - Where send failures are reported. Never rethrown.
 */
export async function sendWelcomeNotifications(
  recipient: WelcomeRecipient,
  log: WelcomeLog,
  /**
   * The domain this account signed up into, when known. Drives which portal the
   * welcome link points at on a split deployment (#569). Undefined for an
   * account with no parked signup domain (migrated or admin-onboarded), which
   * falls back to FRONTEND_BASE_URL and then to no link at all.
   */
  domain?: string | null
): Promise<void> {
  if (!getNotificationClient()) return;

  const appName = instance.INSTANCE_NAME ?? 'DPG';

  if (recipient.email) {
    // Copy comes from the email messages file (#529) — `welcome.*`, overridable
    // per network/brand — and the shared sender owns the from/reply-to address
    // and the HTML shell. Best-effort by registry criticality, so the catch here
    // is belt-and-braces: dispatchEmail already swallows a failed send.
    try {
      const siteUrl = domain
        ? createCtaUrlResolver({
            byDomain: uiHostBindings.byDomain,
            fallbackBaseUrl: notification.FRONTEND_BASE_URL,
          })(domain)
        : notification.FRONTEND_BASE_URL;

      // Role-correct copy: seeker vs provider (service_provider folds into
      // provider). Domain-less signups (migrated / admin-onboarded) fall back
      // to the generic `welcome`.
      const caseId = domain ? `welcome.${resolveRecipientRole(domain)}` : 'welcome';

      const sender = getDefaultEmailSender();
      await sender?.dispatchEmail({
        caseId,
        to: recipient.email,
        fromName: appName,
        variables: {
          userName: recipient.name || 'user',
          appName,
          // Injected ONLY when resolvable: an empty value renders an invisible
          // dead link, while omitting it lets renderSiteLink fall back to the
          // words "the platform".
          ...(siteUrl ? { siteUrl } : {}),
          teamName: appName,
        },
      });
    } catch (err) {
      log.error({ err }, 'welcome: could not send the welcome email');
    }
  }
}
