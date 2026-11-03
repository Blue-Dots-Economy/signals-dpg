import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import { useAuth } from '@/contexts/auth-context';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { toastGuardianSendError } from '@/lib/guardian-consent';
import { readApiError } from '@/lib/api-error';
import { InlineFieldError, fieldErrorAria } from '@/components/forms/inline-field-error';
import { ConsentModal } from '@/components/consent/consent-modal';
import {
  submitGuardian,
  type SubmitGuardianBody,
  type SubmitGuardianResponse,
} from '@/lib/consent-api';

export interface GuardianFormStepProps {
  network: string;
  brand?: string | null;
  /** Called after a successful submit (OTP sent) with the body, so the OTP step can resend. */
  onSubmitted: (body: SubmitGuardianBody) => void;
  /**
   * Defaults to the authenticated `submitGuardian` (POST /u18/guardian). The
   * pre-auth signup flow passes one for POST /u18/signup/guardian.
   */
  submit?: (body: SubmitGuardianBody) => Promise<SubmitGuardianResponse>;
  /**
   * Contact for the same-contact check. Defaults to the signed-in user's;
   * the pre-auth signup flow passes the ward's signup identifier.
   */
  ownContact?: { email?: string | null; phoneNumber?: string | null };
  /** Renders a "Back" control to the birth-year step when set. */
  onBack?: () => void;
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
  onBack,
}: GuardianFormStepProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { config: consentConfig } = useConsentConfig();
  const compareContact = ownContact ?? { email: user?.email, phoneNumber: user?.phoneNumber };

  const [guardianName, setGuardianName] = React.useState('');
  const [guardianEmail, setGuardianEmail] = React.useState('');
  const [guardianPhone, setGuardianPhone] = React.useState('');
  // Send OTP opens the blocking consent gate; accepting records it and sends.
  const [consentAccepted, setConsentAccepted] = React.useState(false);
  const [showConsentGate, setShowConsentGate] = React.useState(false);
  const [serverFlaggedSameContact, setServerFlaggedSameContact] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);
  const [phoneTouched, setPhoneTouched] = React.useState(false);
  // Fields the server rejected (400), cleared when that field is edited.
  const [serverInvalid, setServerInvalid] = React.useState<{ name?: boolean; email?: boolean; phone?: boolean }>({});

  // guardianPhone is the national 10-digit part; the wire value is E.164.
  const guardianPhoneE164 = toE164(guardianPhone);
  const hasContact = Boolean(guardianEmail.trim()) || guardianPhone.length === 10;

  // A ward cannot be their own guardian. Also enforced server-side
  // (409 SAME_CONTACT_NOT_ALLOWED).
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

  const nameLabel = t('u18.guardian_label_parent_name', 'Guardian Name');
  const emailLabel = t('u18.guardian_label_parent_email', 'Guardian Email');
  const phoneLabel = t('u18.guardian_label_parent_phone', 'Guardian Phone Number');
  const invalidWithExample = (label: string, example: string) =>
    t('form.error_invalid_example', 'Invalid entry. {{message}} Example: {{example}}', {
      message: t('form.invalid_format', 'Please enter a valid {{field}}.', { field: label }),
      example,
    });
  const partialPhone = guardianPhone.length > 0 && guardianPhone.length < 10;

  const nameError = serverInvalid.name
    ? t('form.error_invalid', 'Invalid entry. {{message}}', {
        message: t('form.invalid_format', 'Please enter a valid {{field}}.', { field: nameLabel }),
      })
    : submitAttempted && !guardianName.trim()
      ? t('form.error_required', '{{label}} is required.', { label: nameLabel })
      : null;
  const emailError = serverInvalid.email ? invalidWithExample(emailLabel, 'name@example.com') : null;
  const phoneError =
    serverInvalid.phone || (partialPhone && (phoneTouched || submitAttempted))
      ? invalidWithExample(phoneLabel, '9876543210')
      : submitAttempted && !hasContact
        ? t('u18.guardian_error_contact_required', "Enter your guardian's email or phone number.")
        : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setSubmitAttempted(true);
    if (!guardianName.trim() || !hasContact || partialPhone) {
      const firstId = !guardianName.trim() ? 'u18-guardian-name' : 'u18-guardian-phone';
      document.getElementById(firstId)?.focus();
      return;
    }
    // The same-contact message is already shown under the contact fields.
    if (sameContactBlocked) return;

    // With no consent config there is nothing to show, so proceed; the server
    // still records the ward's terms/privacy rows.
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
      const { status, code, fields } = readApiError(err);
      const badFields = {
        name: Boolean(fields?.guardianName),
        email: Boolean(fields?.guardianEmail),
        phone: Boolean(fields?.guardianPhone),
      };

      if (status === 400 && (badFields.name || badFields.email || badFields.phone)) {
        setServerInvalid(badFields);
      } else if (status === 409 && code === 'SAME_CONTACT_NOT_ALLOWED') {
        // Shown under the contact fields.
        setServerFlaggedSameContact(true);
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
      // The U18 consent gate; accepting resumes sending the OTP.
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
          onChange={(e) => {
            setGuardianName(e.target.value);
            setServerInvalid((prev) => ({ ...prev, name: false }));
          }}
          disabled={isSubmitting}
          {...fieldErrorAria('u18-guardian-name-error', nameError)}
        />
        <InlineFieldError id="u18-guardian-name-error" message={nameError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="u18-guardian-email">
          {t('u18.guardian_label_parent_email', 'Guardian Email')}
        </Label>
        <Input
          id="u18-guardian-email"
          type="email"
          value={guardianEmail}
          onChange={(e) => {
            setGuardianEmail(e.target.value);
            clearWarnings();
            setServerInvalid((prev) => ({ ...prev, email: false }));
          }}
          disabled={isSubmitting}
          aria-invalid={Boolean(emailError) || sameContactBlocked || undefined}
          aria-describedby={
            emailError ? 'u18-guardian-email-error' : sameContactBlocked ? 'u18-guardian-same-contact' : undefined
          }
        />
        <InlineFieldError id="u18-guardian-email-error" message={emailError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="u18-guardian-phone">
          {t('u18.guardian_label_parent_phone', 'Guardian Phone Number')}
        </Label>
        <PhoneInput
          id="u18-guardian-phone"
          value={guardianPhone}
          onChange={(v) => {
            setGuardianPhone(v);
            clearWarnings();
            setServerInvalid((prev) => ({ ...prev, phone: false }));
          }}
          onBlur={() => setPhoneTouched(true)}
          disabled={isSubmitting}
          invalid={Boolean(phoneError) || sameContactBlocked}
          describedBy={
            phoneError ? 'u18-guardian-phone-error' : sameContactBlocked ? 'u18-guardian-same-contact' : undefined
          }
        />
        <InlineFieldError id="u18-guardian-phone-error" message={phoneError} />
      </div>

      <p className="text-sm text-muted-foreground">
        {t('u18.guardian_contact_hint', '* At least one contact required — the OTP is sent here.')}
      </p>

      {sameContactBlocked && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3">
          <p id="u18-guardian-same-contact" className="text-sm text-destructive">
            {t(
              'u18.guardian_error_same_contact_not_allowed',
              "Your guardian's contact can't be the same as your own. Please use a different email or phone number.",
            )}
          </p>
        </div>
      )}

      {validationError && <p className="text-sm text-destructive">{validationError}</p>}

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.guardian_continue', 'Continue')}
      </Button>

      {onBack && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={isSubmitting}
          onClick={onBack}
        >
          {t('common.back', 'Back')}
        </Button>
      )}
    </form>
    </>
  );
}
