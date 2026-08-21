import { renderSmsPreview, type SmsTemplateIndex } from './sms_templates';

/**
 * Central SMS sender (#532/#535) — the mirror of the #529 email sender, but
 * provider-agnostic: it posts `{ channel: 'sms', template_id, variables }` to
 * the notification service, which owns the provider (MSG91 today). Nothing
 * here is provider-specific.
 *
 * signalstack owns the id map (option B): `template_id` is the per-brand,
 * DLT-approved flow id from the SMS template index; the notification service
 * passes it through (`allowRawTemplateId`) and renders from the DLT template.
 * When a case has no `template_id` (not yet approved) the send is skipped.
 *
 * Best-effort: never throws, never blocks the triggering action.
 */

export type SmsPriority = 'realtime' | 'other';

/**
 * Mask a phone to its last 4 digits for the dev preview log. The preview is
 * non-prod only, but no raw phone (PII) is ever placed into a log-bound string
 * — a mis-wired previewLog must not be able to leak a full number.
 */
function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `****${tail}` : '****';
}

export interface SmsNotifyRequest {
  channel: 'sms';
  template_id: string;
  to: string;
  priority: SmsPriority;
  variables: Record<string, string>;
}

export interface SmsDispatchArgs {
  caseId: string;
  /** E.164 recipient phone. */
  to: string;
  /** Network selecting the template layer; falls back to the sender default. */
  network?: string | null;
  variables?: Record<string, string>;
  priority?: SmsPriority;
}

export interface SmsSenderDeps {
  notify: (req: SmsNotifyRequest) => Promise<unknown>;
  /** Resolves the SMS template index for a network (layered default/network/brand). */
  getTemplates: (network: string | null) => Promise<SmsTemplateIndex> | SmsTemplateIndex;
  defaultNetwork: string | null;
  /** Non-prod only: called with the rendered reference text so devs see the SMS. */
  previewLog?: (line: string) => void;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface SmsSender {
  dispatchSms(args: SmsDispatchArgs): Promise<{ ok: boolean; skipped?: boolean }>;
}

export function createSmsSender(deps: SmsSenderDeps): SmsSender {
  return {
    async dispatchSms(args) {
      try {
        const network = args.network ?? deps.defaultNetwork;
        const index = await deps.getTemplates(network);
        const entry = index.get(args.caseId);

        if (!entry || !entry.templateId) {
          // Not configured / not yet DLT-approved — a no-op, not an error.
          deps.log('sms template not configured', { caseId: args.caseId, network });
          return { ok: false, skipped: true };
        }

        const variables = args.variables ?? {};

        // Dev preview only — the real text is rendered provider-side from the
        // DLT template; this shows what that will say. Never in prod.
        deps.previewLog?.(
          `[sms:${args.caseId}] to=${maskPhone(args.to)} template_id=${entry.templateId}  ${renderSmsPreview(entry.body, variables)}`,
        );

        await deps.notify({
          channel: 'sms',
          template_id: entry.templateId,
          to: args.to,
          priority: args.priority ?? 'other',
          variables,
        });
        return { ok: true };
      } catch (err) {
        deps.log('sms dispatch failed', { err, caseId: args.caseId });
        return { ok: false };
      }
    },
  };
}
