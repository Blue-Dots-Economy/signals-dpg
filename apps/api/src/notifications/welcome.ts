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

/**
 * The WhatsApp template this uses is a pre-approved Twilio content template;
 * `contentVariables['1']` is the recipient's name. Carried over verbatim from
 * the better-auth hook so both providers send an identical message.
 */
const WELCOME_WHATSAPP_CONTENT_SID = 'HX3f2a5d7e4a18e5664124592a12a154eb';

/** Just enough of the user to address them. */
export interface WelcomeRecipient {
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
 * Send the welcome email and/or WhatsApp message for a newly-created user.
 *
 * Each channel is attempted independently and its failure swallowed, so one
 * dead channel cannot suppress the other. A user with neither identifier, or an
 * instance with no notification client configured, is a silent no-op.
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
  const nc = getNotificationClient();
  if (!nc) return;

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

  if (recipient.phoneNumber) {
    try {
      await nc.notify({
        channel: 'whatsapp',
        template_id: 'other',
        to: recipient.phoneNumber,
        priority: 'realtime',
        variables: {
          contentSid: WELCOME_WHATSAPP_CONTENT_SID,
          contentVariables: {
            '1': recipient.name,
          },
        },
      });
    } catch (err) {
      log.error({ err }, 'welcome: could not send the welcome WhatsApp message');
    }
  }
}
