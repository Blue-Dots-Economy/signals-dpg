import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { submitGuardian, type SubmitGuardianBody } from '@/lib/consent-api';
import { DobStep } from './dob-step';
import { GuardianFormStep } from './guardian-form-step';
import { GuardianOtpStep } from './guardian-otp-step';

type U18Step = 'dob' | 'guardian' | 'otp';

export interface U18GuardianFlowProps {
  network: string;
  brand?: string | null;
  /** Guardian OTP verified — the ward's terms/privacy consent is now recorded server-side. */
  onComplete: () => void;
  /** DOB step resolved the ward as an adult — caller should fall back to the normal consent flow. */
  onNotMinor: () => void;
  /**
   * Step to start on. Defaults to `'dob'` (the original first-login/bulk-user
   * gate on the home page, which doesn't yet know the ward's DOB). A caller
   * that already resolved `isMinor === true` itself via `submitU18Dob` (e.g.
   * the Signals self-signup flow, which collects DOB in its own form before
   * OTP verification) can pass `'guardian'` to skip the redundant DOB step.
   */
  initialStep?: U18Step;
  /**
   * Optional escape hatch. The flow blocks the whole page (a minor must not
   * proceed without a guardian), so the external menu can't be reached — this
   * lets a ward who can't get through (wrong account, backend outage) sign out.
   */
  onLogout?: () => void;
}

/**
 * First-login guardian consent flow for under-18 wards (U18 Phase 6, D1/D4):
 * DOB → guardian details (with same-contact warn-and-ack) → guardian OTP.
 * Blocking, like ProfileConsentModal — cannot be dismissed mid-flow.
 */
export function U18GuardianFlow({
  network,
  brand,
  onComplete,
  onNotMinor,
  initialStep = 'dob',
  onLogout,
}: U18GuardianFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = React.useState<U18Step>(initialStep);
  const [guardianBody, setGuardianBody] = React.useState<SubmitGuardianBody | null>(null);

  const titles: Record<U18Step, string> = {
    dob: t('u18.step_title_dob', "When's your birthday?"),
    guardian: t('u18.step_title_guardian', 'Guardian details'),
    otp: t('u18.step_title_otp', 'Confirm with your guardian'),
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        // Blocking: never dismiss via the Dialog's own open-change. The whole
        // page stays inert so a minor cannot create a profile or act before the
        // guardian confirms.
        if (!next) return;
      }}
      dismissible={false}
      showCloseButton={false}
      title={titles[step]}
      contentClassName="max-w-lg"
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
    >
      <div className="flex flex-col gap-4 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>{titles[step]}</DialogTitle>
          <DialogDescription>
            {t('u18.step_subtitle', "You're under 18, so a parent or guardian needs to confirm this account.")}
          </DialogDescription>
        </DialogHeader>

        {step === 'dob' && (
          <DobStep
            network={network}
            onResolved={(isMinor) => {
              if (isMinor) setStep('guardian');
              else onNotMinor();
            }}
          />
        )}

        {step === 'guardian' && (
          <GuardianFormStep
            network={network}
            brand={brand}
            onSubmitted={(body) => {
              setGuardianBody(body);
              setStep('otp');
            }}
          />
        )}

        {step === 'otp' && (
          <GuardianOtpStep
            network={network}
            brand={brand}
            onVerified={onComplete}
            onResend={async () => {
              if (!guardianBody) return;
              await submitGuardian(guardianBody);
            }}
          />
        )}

        {onLogout && (
          <div className="text-center">
            <button
              type="button"
              onClick={onLogout}
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              {t('u18.logout', 'Not you? Log out')}
            </button>
          </div>
        )}
      </div>
    </ResponsiveDialog>
  );
}
