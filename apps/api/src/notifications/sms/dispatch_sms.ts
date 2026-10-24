import { renderSmsPreview, type SmsTemplateIndex } from './sms_templates';

/**
 * Central SMS sender. Posts `{ channel: 'sms', template_id, variables }` to
 * notification-service, which owns the SMS provider.
 *
 * `template_id` is the DLT-approved id from the SMS template index, which
 * notification-service passes through to the provider. A case with no
 * `template_id` (not yet approved) is skipped.
 *
 * Best-effort: never throws.
 */

export type SmsPriority = 'realtime' | 'other';

/** Masks a phone to its last 4 digits. Never put a raw phone in a log-bound string. */
function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `****${tail}` : '****';
}

/**
 * Keeps only the template's declared `vars` and reports declared keys the
 * caller omitted. A template with no declared vars forwards everything.
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
          // Not configured or not yet DLT-approved: a skip, not an error.
          deps.log('sms template not configured', { caseId: args.caseId, network });
          return { ok: false, skipped: true };
        }

        // Dropping undeclared vars keeps stray PII off the wire; a missing
        // declared var would render blank, so it is logged.
        const variables = selectDeclaredVars(entry.vars, args.variables ?? {}, (missing) =>
          deps.log('sms missing declared variables', { caseId: args.caseId, missing }),
        );

        // Dev preview of the text the provider renders from the DLT template.
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
        // Log the message only: the raw error can carry the phone and variables (PII).
        deps.log('sms dispatch failed', {
          caseId: args.caseId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false };
      }
    },
  };
}
