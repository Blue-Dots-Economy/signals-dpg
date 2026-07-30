import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';

/**
 * What a guardian OTP is being collected for. Rendered as a highlighted panel
 * at the top of every guardian OTP form so the ward + guardian see exactly what
 * the code authorises (profile creation, applying to a provider, etc.) rather
 * than a generic "confirm with your guardian".
 */
export type GuardianPurpose =
  | { kind: 'account' }
  | { kind: 'login' }
  | { kind: 'profile'; name?: string }
  | { kind: 'apply'; provider?: string }
  | { kind: 'connect'; provider?: string }
  | { kind: 'bulk'; action: 'apply' | 'connect'; count: number }
  | { kind: 'accept'; provider?: string };

type TFn = ReturnType<typeof useTranslation>['t'];

/** The bold value line + optional "what it shares" sub-line for a purpose. */
function describe(purpose: GuardianPurpose, t: TFn): { value: string; shares?: string } {
  const org = (provider?: string) =>
    provider ?? t('u18.otp_purpose_org_fallback', 'the organisation');
  const shareWith = (who: string) =>
    t('u18.otp_purpose_shares', {
      defaultValue: 'Shares your name, phone and email with {{who}}.',
      who,
    });

  switch (purpose.kind) {
    case 'account':
      return { value: t('u18.otp_purpose_account', 'Creating your account') };
    case 'login':
      return { value: t('u18.otp_purpose_login', 'Confirming your account') };
    case 'profile':
      return {
        value: purpose.name
          ? t('u18.otp_purpose_profile_named', {
              defaultValue: 'Creating your profile — {{name}}',
              name: purpose.name,
            })
          : t('u18.otp_purpose_profile', 'Creating your profile'),
      };
    case 'apply': {
      const who = org(purpose.provider);
      return {
        value: t('u18.otp_purpose_apply', { defaultValue: 'Applying to {{who}}', who }),
        shares: shareWith(who),
      };
    }
    case 'connect': {
      const who = org(purpose.provider);
      return {
        value: t('u18.otp_purpose_connect', { defaultValue: 'Connecting with {{who}}', who }),
        shares: shareWith(who),
      };
    }
    case 'bulk':
      return {
        value:
          purpose.action === 'connect'
            ? t('u18.otp_purpose_bulk_connect', {
                defaultValue: 'Connecting with {{count}} organisations',
                count: purpose.count,
              })
            : t('u18.otp_purpose_bulk_apply', {
                defaultValue: 'Applying to {{count}} organisations',
                count: purpose.count,
              }),
        shares: t(
          'u18.otp_purpose_shares_them',
          'Shares your name, phone and email with them.',
        ),
      };
    case 'accept': {
      const who = org(purpose.provider);
      return {
        value: t('u18.otp_purpose_accept', {
          defaultValue: "Accepting {{who}}'s shortlist",
          who,
        }),
        shares: shareWith(who),
      };
    }
  }
}

export function GuardianOtpPurpose({ purpose }: { purpose: GuardianPurpose }) {
  const { t } = useTranslation();
  const { value, shares } = describe(purpose, t);
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/50 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-background text-[var(--brand-cta)]">
        <ShieldCheck className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('u18.otp_purpose_label', 'Guardian approval for')}
        </p>
        <p className="text-sm font-semibold text-foreground">{value}</p>
        {shares && <p className="mt-1 text-xs text-muted-foreground">{shares}</p>}
      </div>
    </div>
  );
}
