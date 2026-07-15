import * as React from 'react';
import { useTranslation } from 'react-i18next';
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
 * BEFORE the ward's own login OTP (U18 option A). Rendered inline as the auth
 * page's content (inside AuthShell) — it REPLACES the signup form, matching
 * the DOB step, rather than stacking as a modal over it.
 *
 * DOB was already collected on the previous step, so there's no DOB step here:
 * guardian details → guardian OTP. The captured guardian + consent are
 * materialized onto the new user id once better-auth creates it.
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

  const submit = (body: SubmitGuardianBody) =>
    startSignupGuardian({
      network,
      domain,
      ...identifier,
      birthYear,
      birthMonth,
      guardianName: body.guardianName,
      ...(body.guardianEmail ? { guardianEmail: body.guardianEmail } : {}),
      ...(body.guardianPhone ? { guardianPhone: body.guardianPhone } : {}),
      guardianDeclarationAccepted: body.guardianDeclarationAccepted,
      ...(body.sameContactAcknowledged ? { sameContactAcknowledged: true } : {}),
    });

  const verify = (otp: string) => verifySignupGuardian({ network, ...identifier, otp });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-2xl font-bold text-foreground">
          {step === 'guardian'
            ? t('u18.step_title_guardian', 'Guardian details')
            : t('u18.step_title_otp', 'Confirm with your guardian')}
        </h2>
        {step === 'guardian' && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('u18.step_subtitle', "You're under 18, so a parent or guardian needs to confirm this account.")}
          </p>
        )}
      </div>

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
    </div>
  );
}
