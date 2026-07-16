import * as React from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import { useAuth } from '@/contexts/auth-context';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { toastGuardianSendError } from '@/lib/guardian-consent';
import { ConsentModal, type ConsentModalTab } from '@/components/consent/consent-modal';
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
  // View the T&C / Privacy text in-app (same as everywhere else) instead of
  // navigating away and losing the half-filled guardian form.
  const [consentTab, setConsentTab] = React.useState<ConsentModalTab | null>(null);
  const compareContact = ownContact ?? { email: user?.email, phoneNumber: user?.phoneNumber };

  const [guardianName, setGuardianName] = React.useState('');
  const [guardianEmail, setGuardianEmail] = React.useState('');
  const [guardianPhone, setGuardianPhone] = React.useState('');
  const [termsAccepted, setTermsAccepted] = React.useState(false);
  const [privacyAccepted, setPrivacyAccepted] = React.useState(false);
  const [sameContactAcknowledged, setSameContactAcknowledged] = React.useState(false);
  const [serverFlaggedSameContact, setServerFlaggedSameContact] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  // guardianPhone is the national 10-digit part; the wire value is E.164.
  const guardianPhoneE164 = toE164(guardianPhone);
  const hasContact = Boolean(guardianEmail.trim()) || guardianPhone.length === 10;

  // Same-contact warning: either guardian field matching the ward's own.
  const ownEmail = compareContact.email?.trim().toLowerCase();
  const ownPhone = compareContact.phoneNumber?.trim();
  const clientDetectedSameContact =
    (!!ownEmail && !!guardianEmail.trim() && normalize(guardianEmail).toLowerCase() === ownEmail) ||
    (!!ownPhone && !!guardianPhoneE164 && guardianPhoneE164 === ownPhone);
  const showSameContactWarning = clientDetectedSameContact || serverFlaggedSameContact;

  const clearWarnings = () => {
    setSameContactAcknowledged(false);
    setServerFlaggedSameContact(false);
    setValidationError(null);
  };

  const canSubmit =
    Boolean(guardianName.trim()) &&
    hasContact &&
    termsAccepted &&
    privacyAccepted &&
    (!showSameContactWarning || sameContactAcknowledged) &&
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
    if (!termsAccepted || !privacyAccepted) {
      setValidationError(
        t('u18.guardian_error_consent', 'Please accept both statements on behalf of your ward.'),
      );
      return;
    }
    if (showSameContactWarning && !sameContactAcknowledged) {
      setValidationError(
        t(
          'u18.guardian_error_same_contact_ack',
          'Please confirm you are okay using your own contact for the guardian before continuing.',
        ),
      );
      return;
    }

    setValidationError(null);
    setIsSubmitting(true);
    const body: SubmitGuardianBody = {
      network,
      brand: brand ?? null,
      guardianName: guardianName.trim(),
      ...(guardianEmail.trim() ? { guardianEmail: guardianEmail.trim() } : {}),
      ...(guardianPhone.length === 10 ? { guardianPhone: guardianPhoneE164 } : {}),
      guardianDeclarationAccepted: true,
      ...(showSameContactWarning ? { sameContactAcknowledged: true } : {}),
    };

    try {
      const result = await submit(body);
      if (result.otpSent) onSubmitted(body);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const code = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;

      if (status === 409 && code === 'SAME_CONTACT_NEEDS_ACK') {
        setServerFlaggedSameContact(true);
        setSameContactAcknowledged(false);
        toast.error(
          t(
            'u18.guardian_error_same_contact_ack',
            'Please confirm you are okay using your own contact for the guardian before continuing.',
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
    {consentConfig && consentTab && (
      <ConsentModal
        open
        mode="view"
        initialTab={consentTab}
        config={consentConfig}
        onOpenChange={(next) => { if (!next) setConsentTab(null); }}
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
          aria-invalid={showSameContactWarning}
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
          invalid={showSameContactWarning}
        />
      </div>

      <p className="text-sm text-muted-foreground">
        {t('u18.guardian_contact_hint', '* Please provide at least one contact method (email or phone)')}
      </p>

      {showSameContactWarning && (
        <div className="rounded-md border border-amber-500 bg-amber-50 p-3 dark:bg-amber-950/30">
          <p className="text-sm text-amber-800 dark:text-amber-300 mb-2">
            {t(
              'u18.guardian_same_contact_warning',
              'This is the same as your own contact — are you okay with that?',
            )}
          </p>
          <div className="flex items-start gap-2">
            <Checkbox
              id="u18-same-contact-ack"
              checked={sameContactAcknowledged}
              onCheckedChange={(value) => setSameContactAcknowledged(value === true)}
            />
            <Label htmlFor="u18-same-contact-ack" className="text-sm font-normal leading-snug cursor-pointer">
              {t('u18.guardian_same_contact_ack_label', "Yes, that's okay")}
            </Label>
          </div>
        </div>
      )}

      <div className="flex items-start gap-2">
        <Checkbox
          id="u18-guardian-terms"
          checked={termsAccepted}
          onCheckedChange={(value) => setTermsAccepted(value === true)}
          disabled={isSubmitting}
        />
        <Label htmlFor="u18-guardian-terms" className="text-sm font-normal leading-snug cursor-pointer">
          {t('u18.guardian_accept_terms_prefix', 'On behalf of my ward, I accept the ')}
          {/* Anchor (no href) so it stays a non-labelable element — a <button>
              here would become a second control associated with this label.
              Opens the in-app viewer instead of navigating away. */}
          <a
            role="button"
            tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConsentTab('terms'); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setConsentTab('terms'); }
            }}
            className="underline text-primary cursor-pointer"
          >
            {t('u18.terms_link', 'Terms and Conditions')}
          </a>
        </Label>
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id="u18-guardian-privacy"
          checked={privacyAccepted}
          onCheckedChange={(value) => setPrivacyAccepted(value === true)}
          disabled={isSubmitting}
        />
        <Label htmlFor="u18-guardian-privacy" className="text-sm font-normal leading-snug cursor-pointer">
          {t('u18.guardian_consent_privacy_prefix', 'On behalf of my ward, I consent to Data ')}
          <a
            role="button"
            tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConsentTab('privacy'); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setConsentTab('privacy'); }
            }}
            className="underline text-primary cursor-pointer"
          >
            {t('u18.privacy_link', 'Privacy Policy')}
          </a>
        </Label>
      </div>

      {validationError && <p className="text-sm text-destructive">{validationError}</p>}

      <Button type="submit" disabled={!canSubmit} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.guardian_send_otp', 'Send OTP')}
      </Button>
    </form>
    </>
  );
}
