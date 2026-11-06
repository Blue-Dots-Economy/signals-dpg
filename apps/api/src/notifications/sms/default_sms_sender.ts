import { instance } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { getInstanceDefaultNetwork } from '../email/dispatch_email';
import { createSmsSender, type SmsSender } from './dispatch_sms';
import { getSmsTemplates } from './templates';

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
