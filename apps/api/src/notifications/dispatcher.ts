import { buildNotifications } from './build_notifications';
import type { NotificationEvent, NotificationPlan } from './build_notifications';
import type { DispatchEmailArgs } from './email/dispatch_email';
import {
  FALLBACK_SERVICE_NAME,
  resolveCopyGroup,
  resolveRecipientRole,
} from './action_copy';
import { actionCaseId } from './email/email_cases';

export interface DispatcherDeps {
  /** Sends one rendered email (the central email sender, #529). */
  sendEmail: (args: DispatchEmailArgs) => Promise<{ ok: boolean }>;
  /** Resolves a local owner's email by user id; null when unknown/phone-only. */
  resolveEmail: (userId: string) => Promise<string | null>;
  /**
   * Resolves the counterparty's service name for `{{name}}` in seeker-facing
   * copy (the provider's Service Name); null for provider-facing copy.
   */
  resolveCounterpartyName: (plan: NotificationPlan) => Promise<string | null>;
  brand: {
    brandName: string;
    ctaUrl: string;
  };
  log: (message: string, meta?: Record<string, unknown>) => void;
  /** Visibility hook for skipped (dark) recipients. */
  onSkip: (reason: string) => void;
}

export interface DirectDispatcher {
  dispatch: (event: NotificationEvent) => Promise<void>;
}

/**
 * Resolves recipients and hands each plan to the central email sender.
 * Fire-and-forget by contract: a failure for any plan is logged and never
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

    const counterpartyName = await deps.resolveCounterpartyName(plan);

    await deps.sendEmail({
      caseId: actionCaseId(
        resolveCopyGroup(plan.actionType),
        resolveRecipientRole(plan.recipientDomain),
        plan.shape,
      ),
      to: email,
      fromName: deps.brand.brandName,
      network: plan.counterpartyNetwork,
      ctaUrl: deps.brand.ctaUrl,
      dedupeId: `${plan.actionId}:${plan.updateCount}:${plan.shape}`,
      variables: { name: counterpartyName?.trim() || FALLBACK_SERVICE_NAME },
      log: deps.log,
    });
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
