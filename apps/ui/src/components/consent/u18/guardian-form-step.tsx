import * as React from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import { useAuth } from '@/contexts/auth-context';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { toastGuardianSendError } from '@/lib/guardian-consent';
import { ConsentModal } from '@/components/consent/consent-modal';
import {
  submitGuardian,
  type SubmitGuardianBody,
  type SubmitGuardianResponse,
} from '@/lib/consent-api';

export interface GuardianFormStepProps {
  network: string;
  brand?: string | null;
  /** Called after a successful submit (OTP sent), with the body used — kept by
   * the orchestrator so the OTP step can resend without re-collecting the form. */
  onSubmitted: (body: SubmitGuardianBody) => void;
  /**
   * Submit handler. Defaults to the authenticated `submitGuardian`
   * (POST /u18/guardian). The pre-auth signup flow injects a handler that
   * maps the same body onto POST /u18/signup/guardian (no session yet).
   */
  submit?: (body: SubmitGuardianBody) => Promise<SubmitGuardianResponse>;
  /**
   * Contact to compare against for the same-contact warning. Defaults to the
   * authenticated user's own email/phone; the pre-auth signup flow (no session)
   * passes the ward's signup identifier instead.
   */
  ownContact?: { email?: string | null; phoneNumber?: string | null };
}

function normalize(value: string): string {
  return value.trim();
}

export function GuardianFormStep({
  network,
  brand,
  onSubmitted,
  submit = submitGuardian,
  ownContact,
}: GuardianFormStepProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { config: consentConfig } = useConsentConfig();
  const compareContact = ownContact ?? { email: user?.email, phoneNumber: user?.phoneNumber };

  const [guardianName, setGuardianName] = React.useState('');
  const [guardianEmail, setGuardianEmail] = React.useState('');
  const [guardianPhone, setGuardianPhone] = React.useState('');
  // Consent is captured via the same blocking popup the login flow uses (below):
  // Send OTP opens it, "Accept & continue" records the acceptance and proceeds.
  const [consentAccepted, setConsentAccepted] = React.useState(false);
  const [showConsentGate, setShowConsentGate] = React.useState(false);
  const [serverFlaggedSameContact, setServerFlaggedSameContact] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  // guardianPhone is the national 10-digit part; the wire value is E.164.
  const guardianPhoneE164 = toE164(guardianPhone);
  const hasContact = Boolean(guardianEmail.trim()) || guardianPhone.length === 10;

  // Hard block: a guardian contact equal to the ward's own is NOT allowed (a
  // ward can't be their own guardian). Detected client-side and re-enforced by
  // the server (409 SAME_CONTACT_NOT_ALLOWED).
  const ownEmail = compareContact.email?.trim().toLowerCase();
  const ownPhone = compareContact.phoneNumber?.trim();
  const clientDetectedSameContact =
    (!!ownEmail && !!guardianEmail.trim() && normalize(guardianEmail).toLowerCase() === ownEmail) ||
    (!!ownPhone && !!guardianPhoneE164 && guardianPhoneE164 === ownPhone);
  const sameContactBlocked = clientDetectedSameContact || serverFlaggedSameContact;

  const clearWarnings = () => {
    setServerFlaggedSameContact(false);
    setValidationError(null);
  };

  const canSubmit =
    Boolean(guardianName.trim()) &&
    hasContact &&
    !sameContactBlocked &&
    !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!guardianName.trim()) return;
    if (!hasContact) {
      setValidationError(
        t('u18.guardian_error_contact_required', "Enter your guardian's email or phone number."),
      );
      return;
    }
    if (sameContactBlocked) {
      setValidationError(
        t(
          'u18.guardian_error_same_contact_not_allowed',
          "Your guardian's contact can't be the same as your own. Please use a different email or phone number.",
        ),
      );
      return;
    }

    // Consent via the same blocking popup login uses: open it here; its
    // "Accept & continue" (onAccept below) records acceptance and calls doSubmit.
    // If no consent doc is configured there's nothing to show — proceed (the
    // server still records the ward's terms/privacy rows).
    if (!consentAccepted && consentConfig) {
      setValidationError(null);
      setShowConsentGate(true);
      return;
    }

    await doSubmit();
  };

  const doSubmit = async () => {
    setValidationError(null);
    setIsSubmitting(true);
    const body: SubmitGuardianBody = {
      network,
      brand: brand ?? null,
      guardianName: guardianName.trim(),
      ...(guardianEmail.trim() ? { guardianEmail: guardianEmail.trim() } : {}),
      ...(guardianPhone.length === 10 ? { guardianPhone: guardianPhoneE164 } : {}),
      guardianDeclarationAccepted: true,
    };

    try {
      const result = await submit(body);
      if (result.otpSent) onSubmitted(body);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const code = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;

      if (status === 409 && code === 'SAME_CONTACT_NOT_ALLOWED') {
        setServerFlaggedSameContact(true);
        toast.error(
          t(
            'u18.guardian_error_same_contact_not_allowed',
            "Your guardian's contact can't be the same as your own. Please use a different email or phone number.",
          ),
        );
      } else if (status === 409 && code === 'GUARDIAN_WARD_LIMIT') {
        setValidationError(
          t(
            'u18.guardian_error_ward_limit',
            'This guardian is already linked to the maximum number of accounts. Please use a different guardian contact.',
          ),
        );
      } else {
        toastGuardianSendError(err, t, {
          key: 'u18.guardian_error_generic',
          def: "Couldn't save guardian details. Please try again.",
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
    {consentConfig && showConsentGate && (
      // Same blocking consent popup as login — the ward's guardian reads T&C +
      // Privacy and taps "Accept & continue", which records acceptance and
      // resumes sending the OTP.
      <ConsentModal
        open
        mode="gate"
        initialTab="terms"
        config={consentConfig}
        variant="u18"
        onAccept={() => {
          setConsentAccepted(true);
          setShowConsentGate(false);
          void doSubmit();
        }}
      />
    )}
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="u18-guardian-name">
          {t('u18.guardian_label_parent_name', 'Guardian Name')} *
        </Label>
        <Input
          id="u18-guardian-name"
          value={guardianName}
          onChange={(e) => setGuardianName(e.target.value)}
          disabled={isSubmitting}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="u18-guardian-email">
          {t('u18.guardian_label_parent_email', 'Guardian Email')}
        </Label>
        <Input
          id="u18-guardian-email"
          type="email"
          value={guardianEmail}
          onChange={(e) => { setGuardianEmail(e.target.value); clearWarnings(); }}
          disabled={isSubmitting}
          aria-invalid={sameContactBlocked}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="u18-guardian-phone">
          {t('u18.guardian_label_parent_phone', 'Guardian Phone Number')}
        </Label>
        <PhoneInput
          id="u18-guardian-phone"
          value={guardianPhone}
          onChange={(v) => { setGuardianPhone(v); clearWarnings(); }}
          disabled={isSubmitting}
          invalid={sameContactBlocked}
        />
      </div>

      <p className="text-sm text-muted-foreground">
        {t('u18.guardian_contact_hint', '* At least one contact required — the OTP is sent here.')}
      </p>

      {sameContactBlocked && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3">
          <p className="text-sm text-destructive">
            {t(
              'u18.guardian_error_same_contact_not_allowed',
              "Your guardian's contact can't be the same as your own. Please use a different email or phone number.",
            )}
          </p>
        </div>
      )}

      {validationError && <p className="text-sm text-destructive">{validationError}</p>}

      <Button type="submit" disabled={!canSubmit} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.guardian_continue', 'Continue')}
      </Button>
    </form>
    </>
  );
}
