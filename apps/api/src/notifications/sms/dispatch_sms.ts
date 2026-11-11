import { instance } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { getInstanceDefaultNetwork } from '../email/dispatch_email';
import { renderSmsPreview, type SmsTemplateIndex } from './sms_templates';
import { getSmsTemplates } from './templates';

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

/**
 * Project the caller's variables onto the template's declared `vars`: keep only
 * declared keys (drop undeclared extras) and report any declared key the caller
 * omitted. When a template declares no vars, forward the caller's map as-is.
 */
function selectDeclaredVars(
  declared: string[],
  provided: Record<string, string>,
  onMissing: (missing: string[]) => void,
): Record<string, string> {
  if (declared.length === 0) return provided;
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of declared) {
    if (Object.hasOwn(provided, name)) out[name] = provided[name]!;
    else missing.push(name);
  }
  if (missing.length) onMissing(missing);
  return out;
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
  /** Rethrow a failed send instead of logging it (OTP sends must not fail silently). */
  critical?: boolean;
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

        if (!entry?.templateId) {
          // Not configured / not yet DLT-approved — a no-op, not an error.
          deps.log('sms template not configured', { caseId: args.caseId, network });
          return { ok: false, skipped: true };
        }

        // Enforce the declared variable contract: forward ONLY the vars the
        // DLT template expects (dropping undeclared extras keeps stray PII off
        // the wire), and surface any declared var the caller failed to supply
        // — it would otherwise render blank in the delivered SMS.
        const variables = selectDeclaredVars(entry.vars, args.variables ?? {}, (missing) =>
          deps.log('sms missing declared variables', { caseId: args.caseId, missing }),
        );

        // Dev preview only, never in prod. Skipped for critical sends: those
        // carry an OTP, which must not reach a log even outside production.
        if (!args.critical) deps.previewLog?.(
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
        // Log the message only — never the raw error object, which can
        // serialize the provider request/response (phone, variables = PII).
        deps.log('sms dispatch failed', {
          caseId: args.caseId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (args.critical) throw err;
        return { ok: false };
      }
    },
  };
}

let defaultSender: SmsSender | null | undefined;

/**
 * The instance SMS sender, or null when no notification client is configured.
 * A case sends only where the instance's SMS template file gives it a
 * `template_id`; everywhere else `dispatchSms` skips.
 */
export function getDefaultSmsSender(): SmsSender | null {
  if (defaultSender !== undefined) return defaultSender;
  const nc = getNotificationClient();
  defaultSender = nc
    ? createSmsSender({
        notify: (req) => nc.notify(req),
        getTemplates: () => getSmsTemplates(),
        defaultNetwork: getInstanceDefaultNetwork(),
        // The preview line masks the phone; still kept out of production logs.
        previewLog:
          instance.INSTANCE_ENV === 'production' ? undefined : (line) => console.info(line),
        log: (message, meta) => console.warn(message, meta ?? {}),
      })
    : null;
  return defaultSender;
}

export function resetDefaultSmsSenderForTests(): void {
  defaultSender = undefined;
}

/** The bare origin of an app link, the form the DLT `{#url#}` samples use. */
export function smsLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
