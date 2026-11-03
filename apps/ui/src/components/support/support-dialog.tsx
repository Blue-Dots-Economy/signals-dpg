import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { apiErrorMessage, isReadableServerMessage, readApiError } from '@/lib/api-error';
import { InlineFieldError, fieldErrorAria } from '@/components/forms/inline-field-error';
import { Loader2, Paperclip, X } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { submitSupport, type SupportType } from '@/lib/support-api';
import { useSupportConfig } from '@/hooks/use-support-config';
import {
  encodeAttachments,
  formatBytes,
  pickerAccept,
  validateAttachmentSelection,
} from '@/lib/support-attachments';

interface SupportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Maps a failed submit that no field owns to its toast. */
function resolveSubmitErrorToast(
  err: unknown,
  t: Translate,
): { title: string; description?: string } {
  const { status } = readApiError(err);
  if (status === 503) {
    return { title: t('support.toast_unavailable'), description: t('support.toast_unavailable_desc') };
  }
  if (status === 429) {
    return { title: t('support.toast_rate_limited'), description: t('support.toast_rate_limited_desc') };
  }
  return {
    title: t('support.toast_error'),
    description: apiErrorMessage(err, t as TFunction, t('support.toast_error_desc')),
  };
}

type SupportField = 'name' | 'email' | 'phone' | 'details' | 'contact' | 'consent' | 'attachments';

export function SupportDialog({ open, onOpenChange }: SupportDialogProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<SupportType>('complaint');
  const [details, setDetails] = useState('');
  const [consent, setConsent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  // Messages from the server or the attachment picker, cleared when that field changes.
  const [extraErrors, setExtraErrors] = useState<Partial<Record<SupportField, string>>>({});
  const clearExtra = (field: SupportField) =>
    setExtraErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Limits come from the API, fetched only while the dialog is open.
  const { config } = useSupportConfig(open);

  // Prefill contact fields from the signed-in user on open.
  useEffect(() => {
    if (!open) return;
    setName(user?.name ?? '');
    setEmail(user?.email ?? '');
    setPhone(user?.phoneNumber ?? '');
  }, [open, user]);

  const reset = () => {
    setType('complaint');
    setDetails('');
    setConsent(false);
    setAttachments([]);
    setSubmitAttempted(false);
    setExtraErrors({});
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? []);
    // Clear the input so re-picking the same file still fires onChange.
    e.target.value = '';
    if (incoming.length === 0) return;

    const result = validateAttachmentSelection(attachments, incoming, config);
    if (!result.ok) {
      const message =
        result.reason === 'count'
          ? t('support.validation_attachment_count', { count: config.maxFiles })
          : result.reason === 'size'
            ? t('support.validation_attachment_size', { size: formatBytes(config.maxTotalBytes) })
            : t('support.validation_attachment_type', { name: result.filename });
      setExtraErrors((prev) => ({ ...prev, attachments: message }));
      return;
    }
    clearExtra('attachments');
    setAttachments(result.files);
  };

  const removeAttachment = (index: number) => {
    clearExtra('attachments');
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const attachedBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const trimmedPhone = phone.trim();
  const hasContact = Boolean(trimmedEmail || trimmedPhone);

  const invalidField = (label: string, example?: string) => {
    const message = t('form.invalid_format', 'Please enter a valid {{field}}.', { field: label });
    return example
      ? t('form.error_invalid_example', 'Invalid entry. {{message}} Example: {{example}}', { message, example })
      : t('form.error_invalid', 'Invalid entry. {{message}}', { message });
  };
  const errors: Partial<Record<SupportField, string>> = {
    name:
      extraErrors.name ??
      (submitAttempted && !trimmedName
        ? t('form.error_required', '{{label}} is required.', { label: t('support.label_name') })
        : undefined),
    email: extraErrors.email,
    phone: extraErrors.phone,
    contact: submitAttempted && !hasContact ? t('support.validation_contact_required') : undefined,
    details:
      extraErrors.details ??
      (submitAttempted && !details.trim() ? t('support.validation_details_required') : undefined),
    consent: submitAttempted && !consent ? t('support.validation_consent_required') : undefined,
    attachments: extraErrors.attachments,
  };
  const FIELD_IDS: Record<SupportField, string> = {
    name: 'support-name',
    email: 'support-email',
    phone: 'support-phone',
    contact: 'support-email',
    details: 'support-details',
    consent: 'support-consent',
    attachments: 'support-attachments-button',
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setSubmitAttempted(true);
    const missing = (['name', 'contact', 'details', 'consent'] as const).find((field) =>
      field === 'name' ? !trimmedName : field === 'contact' ? !hasContact : field === 'details' ? !details.trim() : !consent,
    );
    if (missing) {
      document.getElementById(FIELD_IDS[missing])?.focus();
      return;
    }
    setIsSubmitting(true);
    try {
      // Encode inside the submitting state, since a large file takes a while.
      const encoded = attachments.length ? await encodeAttachments(attachments) : undefined;
      await submitSupport({
        name: trimmedName,
        email: trimmedEmail || undefined,
        phone: trimmedPhone || undefined,
        type,
        details: details.trim(),
        consent: true,
        ...(encoded ? { attachments: encoded } : {}),
      });
      toast.success(t('support.toast_sent'), { description: t('support.toast_sent_desc') });
      reset();
      onOpenChange(false);
    } catch (err) {
      const info = readApiError(err);
      const labels = {
        name: t('support.label_name'),
        email: t('support.label_email'),
        phone: t('support.label_phone'),
        details: t('support.label_details'),
      };
      const fieldErrors: Partial<Record<SupportField, string>> = {};
      if (info.status === 413) {
        // The server's body limit, not its attachment check.
        fieldErrors.attachments = t('support.validation_attachment_size', { size: formatBytes(config.maxTotalBytes) });
      } else if (info.status === 400 && info.code?.startsWith('ATTACHMENT_')) {
        // Its message names the file the client check missed.
        fieldErrors.attachments = isReadableServerMessage(info.message)
          ? info.message
          : t('support.toast_attachment_rejected');
      } else if (info.status === 400 && info.fields) {
        for (const key of ['name', 'email', 'phone', 'details'] as const) {
          if (info.fields[key]) {
            const example = key === 'email' ? 'name@example.com' : key === 'phone' ? '9876543210' : undefined;
            fieldErrors[key] = invalidField(labels[key], example);
          }
        }
      }
      const fieldKeys = Object.keys(fieldErrors) as SupportField[];
      if (fieldKeys.length > 0) {
        setExtraErrors((prev) => ({ ...prev, ...fieldErrors }));
        document.getElementById(FIELD_IDS[fieldKeys[0]!])?.focus();
      } else {
        const { title, description } = resolveSubmitErrorToast(err, t);
        toast.error(title, description ? { description } : undefined);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('support.dialog_title')}
      contentClassName="sm:max-w-md"
    >
      <div className="flex flex-col gap-4 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>{t('support.dialog_title')}</DialogTitle>
          <DialogDescription>{t('support.dialog_desc')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="support-name">{t('support.label_name')}</Label>
            <Input
              id="support-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearExtra('name');
              }}
              maxLength={200}
              disabled={isSubmitting}
              {...fieldErrorAria('support-name-error', errors.name)}
            />
            <InlineFieldError id="support-name-error" message={errors.name} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-email">{t('support.label_email')}</Label>
            <Input
              id="support-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearExtra('email');
              }}
              maxLength={320}
              disabled={isSubmitting}
              {...fieldErrorAria(
                errors.email ? 'support-email-error' : 'support-contact-error',
                errors.email ?? errors.contact,
              )}
            />
            <InlineFieldError id="support-email-error" message={errors.email} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-phone">{t('support.label_phone')}</Label>
            <Input
              id="support-phone"
              type="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                clearExtra('phone');
              }}
              maxLength={20}
              disabled={isSubmitting}
              {...fieldErrorAria(
                errors.phone ? 'support-phone-error' : 'support-contact-error',
                errors.phone ?? errors.contact,
              )}
            />
            <InlineFieldError id="support-phone-error" message={errors.phone} />
            <InlineFieldError id="support-contact-error" message={errors.contact} />
          </div>
          <fieldset className="space-y-1.5" disabled={isSubmitting}>
            <legend className="text-sm font-medium">{t('support.label_type')}</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="support-type"
                  value="complaint"
                  checked={type === 'complaint'}
                  onChange={() => setType('complaint')}
                />
                {t('support.type_complaint')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="support-type"
                  value="support_request"
                  checked={type === 'support_request'}
                  onChange={() => setType('support_request')}
                />
                {t('support.type_support_request')}
              </label>
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="support-details">{t('support.label_details')}</Label>
            <Textarea
              id="support-details"
              value={details}
              onChange={(e) => {
                setDetails(e.target.value);
                clearExtra('details');
              }}
              placeholder={t('support.placeholder_details')}
              maxLength={5000}
              rows={5}
              disabled={isSubmitting}
              {...fieldErrorAria('support-details-error', errors.details)}
            />
            <InlineFieldError id="support-details-error" message={errors.details} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-attachments">{t('support.label_attachments')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('support.attachments_hint', {
                count: config.maxFiles,
                size: formatBytes(config.maxTotalBytes),
              })}
            </p>
            <input
              ref={fileInputRef}
              id="support-attachments"
              type="file"
              multiple
              accept={pickerAccept(config)}
              onChange={handleFilesSelected}
              disabled={isSubmitting || attachments.length >= config.maxFiles}
              className="sr-only"
            />
            <button
              id="support-attachments-button"
              type="button"
              {...fieldErrorAria('support-attachments-error', errors.attachments)}
              onClick={() => fileInputRef.current?.click()}
              disabled={isSubmitting || attachments.length >= config.maxFiles}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-60"
            >
              <Paperclip className="h-4 w-4" />
              {t('support.attachments_add')}
            </button>
            <InlineFieldError id="support-attachments-error" message={errors.attachments} />
            {attachments.length > 0 && (
              <ul className="space-y-1">
                {attachments.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1 text-sm"
                  >
                    <span className="truncate">{file.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {formatBytes(file.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        disabled={isSubmitting}
                        aria-label={t('support.attachments_remove', { name: file.name })}
                        className="rounded p-0.5 disabled:opacity-60"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </li>
                ))}
                <li className="text-xs text-muted-foreground">
                  {t('support.attachments_total', {
                    used: formatBytes(attachedBytes),
                    total: formatBytes(config.maxTotalBytes),
                  })}
                </li>
              </ul>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-start gap-2">
              <Checkbox
                id="support-consent"
                checked={consent}
                onCheckedChange={(checked) => setConsent(checked === true)}
                disabled={isSubmitting}
                {...fieldErrorAria('support-consent-error', errors.consent)}
              />
              <Label htmlFor="support-consent" className="text-sm font-normal leading-snug">
                {t('support.consent_text')}
              </Label>
            </div>
            <InlineFieldError id="support-consent-error" message={errors.consent} />
          </div>
          <DialogFooter>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('support.submit')}
            </button>
          </DialogFooter>
        </form>
      </div>
    </ResponsiveDialog>
  );
}
