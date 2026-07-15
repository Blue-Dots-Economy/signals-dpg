import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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
}

/**
 * First-login guardian consent flow for under-18 wards (U18 Phase 6, D1/D4):
 * DOB → guardian details (with same-contact warn-and-ack) → guardian OTP.
 * Blocking, like ProfileConsentModal — cannot be dismissed mid-flow.
 */
export function U18GuardianFlow({ network, brand, onComplete, onNotMinor }: U18GuardianFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = React.useState<U18Step>('dob');
  const [guardianBody, setGuardianBody] = React.useState<SubmitGuardianBody | null>(null);

  const titles: Record<U18Step, string> = {
    dob: t('u18.step_title_dob', "When's your birthday?"),
    guardian: t('u18.step_title_guardian', 'Guardian details'),
    otp: t('u18.step_title_otp', 'Confirm with your guardian'),
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Blocking: never dismiss via the Dialog's own open-change.
        if (!next) return;
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-lg"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
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
      </DialogContent>
    </Dialog>
  );
}
