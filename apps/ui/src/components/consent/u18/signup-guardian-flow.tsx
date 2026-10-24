import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  /** Ward's age captured on the birth-year step. */
  age: number;
  /** Guardian OTP verified server-side; the caller creates the ward's account. */
  onComplete: () => void;
  /** Back to the birth-year step (rendered on the previous screen). */
  onBack?: () => void;
}

/**
 * Pre-auth guardian consent for an under-18 ward during signup, before the
 * account exists: guardian details, then guardian OTP. Rendered inline in
 * place of the signup form. The server keys this on the signup identifier and
 * attaches the guardian and consent to the user when the account is created.
 */
export function SignupGuardianFlow({
  network,
  domain,
  brand,
  identifier,
  age,
  onComplete,
  onBack,
}: SignupGuardianFlowProps) {
  const { t } = useTranslation();
  // 'verified' is an explicit hand-off: the ward clicks to continue to their
  // own account step rather than being moved on silently.
  const [step, setStep] = React.useState<'guardian' | 'otp' | 'verified'>('guardian');
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
      age,
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
            : step === 'otp'
              ? t('u18.step_title_otp', 'Confirm with your guardian')
              : t('u18.guardian_verified_title', 'Guardian confirmed')}
        </h2>
        {step === 'guardian' && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('u18.step_subtitle', "You're under 18, so a guardian needs to confirm this account.")}
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
          onBack={onBack}
        />
      )}

      {step === 'otp' && (
        <GuardianOtpStep
          network={network}
          brand={brand}
          verify={verify}
          purpose={{ kind: 'account' }}
          onVerified={() => setStep('verified')}
          onResend={async () => {
            if (!guardianBody) return;
            await submit(guardianBody);
          }}
        />
      )}

      {step === 'verified' && (
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3 rounded-md border border-emerald-500/40 bg-emerald-50 p-3 dark:bg-emerald-950/30">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="text-sm text-foreground">
              {t(
                'u18.guardian_verified_desc',
                'Your guardian has confirmed. Next, verify your account to finish signing up.',
              )}
            </p>
          </div>
          <Button type="button" onClick={onComplete} className="w-full">
            {t('u18.guardian_verified_continue', 'Continue')}
          </Button>
        </div>
      )}
    </div>
  );
}
