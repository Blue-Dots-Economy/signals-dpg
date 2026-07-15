import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  startSignupGuardian,
  verifySignupGuardian,
  type SubmitGuardianBody,
} from '@/lib/consent-api';
import { GuardianFormStep } from './guardian-form-step';
import { GuardianOtpStep } from './guardian-otp-step';

/** The ward's own signup identifier — exactly one of the two. */
export type SignupIdentifier = { email: string } | { phoneNumber: string };

export interface SignupGuardianFlowProps {
  network: string;
  domain: string;
  brand?: string | null;
  /** The ward's own signup identifier (no account exists yet). */
  identifier: SignupIdentifier;
  birthYear: number;
  birthMonth: number;
  /** Guardian OTP verified server-side — caller proceeds to the ward's own OTP. */
  onComplete: () => void;
}

/**
 * PRE-AUTH guardian consent flow, run DURING signup for an under-18 ward,
 * BEFORE the ward's own login OTP (U18 option A). The account doesn't exist
 * yet, so this is keyed on the ward's signup identifier and backed by the
 * public /u18/signup/guardian[/verify] routes; the captured guardian +
 * consent are materialized onto the new user id once better-auth creates it
 * (afterUserCreate → materializeSignupGuardian).
 *
 * DOB was already collected on the signup form, so there is no DOB step here
 * (unlike the first-login U18GuardianFlow): guardian details → guardian OTP.
 * Blocking, like U18GuardianFlow — cannot be dismissed mid-flow.
 */
export function SignupGuardianFlow({
  network,
  domain,
  brand,
  identifier,
  birthYear,
  birthMonth,
  onComplete,
}: SignupGuardianFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = React.useState<'guardian' | 'otp'>('guardian');
  const [guardianBody, setGuardianBody] = React.useState<SubmitGuardianBody | null>(null);

  const ownContact = {
    email: 'email' in identifier ? identifier.email : null,
    phoneNumber: 'phoneNumber' in identifier ? identifier.phoneNumber : null,
  };

  // Map the shared guardian-form body onto the pre-auth signup endpoint, which
  // additionally needs the domain + identifier + birth month/year the server
  // uses to re-confirm the ward is a gated minor.
  const submit = (body: SubmitGuardianBody) =>
    startSignupGuardian({
      network,
      domain,
      ...identifier,
      birthYear,
      birthMonth,
      guardianName: body.guardianName,
      guardianContact: body.guardianContact,
      guardianContactType: body.guardianContactType,
      guardianDeclarationAccepted: body.guardianDeclarationAccepted,
      ...(body.sameContactAcknowledged ? { sameContactAcknowledged: true } : {}),
    });

  const verify = (otp: string) => verifySignupGuardian({ network, ...identifier, otp });

  const titles: Record<'guardian' | 'otp', string> = {
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

        {step === 'guardian' && (
          <GuardianFormStep
            network={network}
            brand={brand}
            submit={submit}
            ownContact={ownContact}
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
            verify={verify}
            onVerified={onComplete}
            onResend={async () => {
              if (!guardianBody) return;
              await submit(guardianBody);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
