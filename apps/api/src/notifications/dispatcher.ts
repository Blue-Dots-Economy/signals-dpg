import { actionEvent, type ActionEventShape } from '@dpg/notification';

import { buildNotifications } from './build_notifications';
import type { NotificationEvent, NotificationPlan } from './build_notifications';
import { FALLBACK_SERVICE_NAME } from './action_copy';
import { sendBestEffort, type SendEvent } from './send_event';

export interface DispatcherDeps {
  /** Posts one event to the notification service, which picks the copy and channel. */
  send: SendEvent;
  /** Resolves a local owner's email by user id; null when unknown/phone-only. */
  resolveEmail: (userId: string) => Promise<string | null>;
  /**
   * Resolves the counterparty's service name for `{{name}}` in seeker-facing
   * copy (the provider's Service Name); null for provider-facing copy.
   */
  resolveCounterpartyName: (plan: NotificationPlan) => Promise<string | null>;
  /** "Team <name>" sign-off carried on every event (`variables.teamName`). */
  teamName: string;
  /**
   * The login URL for a recipient in `domain`. Per-recipient, not per-process:
   * on a split deployment each domain has its own portal host (#569).
   */
  resolveCtaUrl: (domain: string) => string | undefined;
  log: (message: string, meta?: Record<string, unknown>) => void;
  /** Visibility hook for skipped (dark) recipients. */
  onSkip: (reason: string) => void;
}

export interface DirectDispatcher {
  dispatch: (event: NotificationEvent) => Promise<void>;
}

/**
 * Resolves recipients and sends one `action.<actionType>.<shape>` event per
 * plan. The notification service's policy for the recipient's domain picks
 * the copy (connect/apply, seeker/provider). Fire-and-forget by contract: a failure for any plan is logged and never
 * propagates, so it can never fail or slow the action route. The Phase-2
 * transport (Kafka/registry) swaps in behind this same interface.
 */
export function createDirectDispatcher(deps: DispatcherDeps): DirectDispatcher {
  async function dispatchPlan(plan: NotificationPlan): Promise<void> {
    if (!plan.recipientUserId) {
      deps.onSkip('no_user_id');
      deps.log('notification skipped: owner has no user id', {
        shape: plan.shape,
        actionId: plan.actionId,
      });
      return;
    }

    const email = await deps.resolveEmail(plan.recipientUserId);
    if (!email) {
      deps.onSkip('no_email');
      deps.log('notification skipped: owner has no email', {
        shape: plan.shape,
        actionId: plan.actionId,
      });
      return;
    }

    // A missing URL would leave the email's only call to action broken, so
    // send nothing; the boot-time unknown-domain warning is the operator-facing
    // signal. The gate accepts a map-only config (UI_HOST_BINDINGS without
    // FRONTEND_BASE_URL), so a domain absent from the map has no answer.
    //
    // The RECIPIENT's own domain, never the counterparty's — keying off
    // `counterpartyDomain` here would send each party to the other's portal.
    const ctaUrl = deps.resolveCtaUrl(plan.recipientDomain);
    if (!ctaUrl) {
      deps.onSkip('no_cta_url');
      deps.log('notification skipped: no CTA url for recipient domain', {
        shape: plan.shape,
        actionId: plan.actionId,
        domain: plan.recipientDomain,
      });
      return;
    }

    const counterpartyName = await deps.resolveCounterpartyName(plan);

    const event_type = actionEvent(
      plan.actionType,
      plan.shape.toLowerCase() as ActionEventShape,
    );
    await sendBestEffort(
      deps.send,
      {
        event_type,
        domain: plan.recipientDomain,
        to: { email },
        variables: {
          name: counterpartyName?.trim() || FALLBACK_SERVICE_NAME,
          ctaUrl,
          teamName: deps.teamName,
        },
        priority: 'normal',
        idempotency_key: `${plan.actionId}:${plan.updateCount}:${plan.shape}`,
      },
      deps.log,
      { actionId: plan.actionId, shape: plan.shape },
    );
  }

  return {
    async dispatch(event: NotificationEvent): Promise<void> {
      const plans = buildNotifications(event);
      for (const plan of plans) {
        try {
          await dispatchPlan(plan);
        } catch (err) {
          deps.log('notification dispatch failed', {
            err,
            shape: plan.shape,
            actionId: plan.actionId,
          });
        }
      }
    },
  };
}
