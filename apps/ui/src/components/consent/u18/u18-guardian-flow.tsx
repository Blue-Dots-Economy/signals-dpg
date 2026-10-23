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
import { type GuardianPurpose } from './guardian-otp-purpose';

type U18Step = 'dob' | 'guardian' | 'otp';

export interface U18GuardianFlowProps {
  network: string;
  brand?: string | null;
  /** Guardian OTP verified — the ward's terms/privacy consent is now recorded server-side. */
  onComplete: () => void;
  /** DOB step resolved the ward as an adult — caller should fall back to the normal consent flow. */
  onNotMinor: () => void;
  /**
   * Step to start on. `'dob'` when the ward's age is unknown; a caller that
   * already knows the ward is a minor passes `'guardian'`.
   */
  initialStep?: U18Step;
  /**
   * Escape hatch: the flow blocks the whole page, so this lets a ward who
   * cannot get through (wrong account, outage) sign out.
   */
  onLogout?: () => void;
  /**
   * Render the steps inline instead of in a blocking dialog, for the auth
   * pages' panel (like SignupGuardianFlow).
   */
  inline?: boolean;
  /** What this OTP authorises — passed to the guardian OTP step's purpose panel. */
  purpose?: GuardianPurpose;
}

/**
 * Guardian consent flow for a signed-in under-18 ward: DOB, guardian details,
 * guardian OTP. Blocking; cannot be dismissed mid-flow.
 */
export function U18GuardianFlow({
  network,
  brand,
  onComplete,
  onNotMinor,
  initialStep = 'dob',
  onLogout,
  inline = false,
  purpose,
}: U18GuardianFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = React.useState<U18Step>(initialStep);
  const [guardianBody, setGuardianBody] = React.useState<SubmitGuardianBody | null>(null);

  const titles: Record<U18Step, string> = {
    dob: t('u18.step_title_dob', "When's your birthday?"),
    guardian: t('u18.step_title_guardian', 'Guardian details'),
    otp: t('u18.step_title_otp', 'Confirm with your guardian'),
  };

  const subtitle = t(
    'u18.step_subtitle',
    "You're under 18, so a guardian needs to confirm this account.",
  );

  const steps = (
    <>
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
          // Back only when this flow started at the DOB step.
          onBack={initialStep === 'dob' ? () => setStep('dob') : undefined}
        />
      )}

      {step === 'otp' && (
        <GuardianOtpStep
          network={network}
          brand={brand}
          purpose={purpose}
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
    </>
  );

  if (inline) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">{titles[step]}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {steps}
      </div>
    );
  }

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        // Blocking, so a minor cannot act before the guardian confirms.
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
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        {steps}
      </div>
    </ResponsiveDialog>
  );
}
