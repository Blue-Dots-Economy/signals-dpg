import * as React from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/auth-context';
import {
  submitGuardian,
  type GuardianContactType,
  type SubmitGuardianBody,
} from '@/lib/consent-api';

export interface GuardianFormStepProps {
  network: string;
  brand?: string | null;
  /** Called after a successful submit (OTP sent), with the body used — kept by
   * the orchestrator so the OTP step can resend without re-collecting the form. */
  onSubmitted: (body: SubmitGuardianBody) => void;
}

function normalizeContact(value: string): string {
  return value.trim();
}

/** Mirrors the server's own-contact check (apps/api .../u18_guardian.ts) so the
 * warning appears client-side before a round trip, though the server remains
 * the source of truth (a 409 SAME_CONTACT_NEEDS_ACK re-surfaces this if we miss it). */
function matchesOwnContact(
  contact: string,
  ownEmail: string | null | undefined,
  ownPhone: string | null | undefined,
): boolean {
  const normalized = normalizeContact(contact);
  if (!normalized) return false;
  const matchesEmail = !!ownEmail && normalized.toLowerCase() === ownEmail.trim().toLowerCase();
  const matchesPhone = !!ownPhone && normalized === ownPhone.trim();
  return matchesEmail || matchesPhone;
}

export function GuardianFormStep({ network, brand, onSubmitted }: GuardianFormStepProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [guardianName, setGuardianName] = React.useState('');
  const [guardianContact, setGuardianContact] = React.useState('');
  const [guardianContactType, setGuardianContactType] = React.useState<GuardianContactType>('phone');
  const [declarationAccepted, setDeclarationAccepted] = React.useState(false);
  const [sameContactAcknowledged, setSameContactAcknowledged] = React.useState(false);
  const [serverFlaggedSameContact, setServerFlaggedSameContact] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const clientDetectedSameContact = matchesOwnContact(
    guardianContact,
    user?.email,
    user?.phoneNumber,
  );
  const showSameContactWarning = clientDetectedSameContact || serverFlaggedSameContact;

  // Editing the contact after a warning invalidates the previous acknowledgement.
  const handleContactChange = (value: string) => {
    setGuardianContact(value);
    setSameContactAcknowledged(false);
    setServerFlaggedSameContact(false);
    setValidationError(null);
  };

  const canSubmit =
    Boolean(guardianName.trim()) &&
    Boolean(guardianContact.trim()) &&
    declarationAccepted &&
    (!showSameContactWarning || sameContactAcknowledged) &&
    !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!guardianName.trim() || !guardianContact.trim()) return;
    if (!declarationAccepted) {
      setValidationError(
        t('u18.guardian_error_declaration', 'Please confirm the guardian declaration to continue.'),
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
      guardianContact: guardianContact.trim(),
      guardianContactType,
      guardianDeclarationAccepted: true,
      ...(showSameContactWarning ? { sameContactAcknowledged: true } : {}),
    };

    try {
      const result = await submitGuardian(body);
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
      } else if (status === 429) {
        toast.error(
          t('u18.guardian_error_rate_limited', 'Too many attempts. Please try again shortly.'),
        );
      } else if (status === 503) {
        toast.error(
          t(
            'u18.guardian_error_otp_unavailable',
            "Guardian confirmation isn't available on this instance right now.",
          ),
        );
      } else {
        toast.error(
          t('u18.guardian_error_generic', "Couldn't save guardian details. Please try again."),
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t(
          'u18.guardian_desc',
          "Since you're under 18, we need a parent or guardian to confirm your account.",
        )}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="u18-guardian-name">{t('u18.guardian_label_name', "Guardian's name")}</Label>
        <Input
          id="u18-guardian-name"
          value={guardianName}
          onChange={(e) => setGuardianName(e.target.value)}
          disabled={isSubmitting}
          required
        />
      </div>

      <fieldset className="space-y-1.5" disabled={isSubmitting}>
        <legend className="text-sm font-medium">
          {t('u18.guardian_label_contact_type', 'How should we contact your guardian?')}
        </legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="u18-guardian-contact-type"
              value="phone"
              checked={guardianContactType === 'phone'}
              onChange={() => setGuardianContactType('phone')}
            />
            {t('u18.guardian_contact_type_phone', 'Phone')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="u18-guardian-contact-type"
              value="email"
              checked={guardianContactType === 'email'}
              onChange={() => setGuardianContactType('email')}
            />
            {t('u18.guardian_contact_type_email', 'Email')}
          </label>
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="u18-guardian-contact">
          {guardianContactType === 'email'
            ? t('u18.guardian_label_contact_email', "Guardian's email")
            : t('u18.guardian_label_contact_phone', "Guardian's phone number")}
        </Label>
        <Input
          id="u18-guardian-contact"
          type={guardianContactType === 'email' ? 'email' : 'tel'}
          value={guardianContact}
          onChange={(e) => handleContactChange(e.target.value)}
          disabled={isSubmitting}
          required
          aria-invalid={showSameContactWarning}
          className={cn(
            showSameContactWarning && 'border-amber-500 focus-visible:ring-amber-500/40',
          )}
        />
      </div>

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
          id="u18-guardian-declaration"
          checked={declarationAccepted}
          onCheckedChange={(value) => setDeclarationAccepted(value === true)}
          disabled={isSubmitting}
        />
        <Label htmlFor="u18-guardian-declaration" className="text-sm font-normal leading-snug cursor-pointer">
          {t(
            'u18.guardian_declaration_label',
            "I declare that the details above belong to my parent or guardian and that I'm asking them to confirm.",
          )}
        </Label>
      </div>

      {validationError && <p className="text-sm text-destructive">{validationError}</p>}

      <Button type="submit" disabled={!canSubmit} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.guardian_continue', 'Send guardian confirmation')}
      </Button>
    </form>
  );
}
