import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import axios from 'axios';
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
  validateAttachmentSelection,
} from '@/lib/support-attachments';

interface SupportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Limits come from the API so the form can never disagree with it; only
  // fetched while the dialog is open.
  const { config } = useSupportConfig(open);

  // Prefill contact fields from the logged-in user whenever the dialog opens.
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
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? []);
    // Clear the input either way, so re-picking the same file still fires
    // onChange and a rejected pick doesn't linger in the control.
    e.target.value = '';
    if (incoming.length === 0) return;

    const result = validateAttachmentSelection(attachments, incoming, config);
    if (!result.ok) {
      if (result.reason === 'count') {
        toast.error(t('support.validation_attachment_count', { count: config.maxFiles }));
      } else if (result.reason === 'size') {
        toast.error(
          t('support.validation_attachment_size', { size: formatBytes(config.maxTotalBytes) }),
        );
      } else {
        toast.error(t('support.validation_attachment_type', { name: result.filename }));
      }
      return;
    }
    setAttachments(result.files);
  };

  const removeAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const attachedBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const trimmedPhone = phone.trim();
  const hasContact = Boolean(trimmedEmail || trimmedPhone);
  const canSubmit =
    Boolean(trimmedName) && Boolean(details.trim()) && hasContact && consent && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!details.trim()) {
      toast.error(t('support.validation_details_required'));
      return;
    }
    if (!hasContact) {
      toast.error(t('support.validation_contact_required'));
      return;
    }
    if (!consent) {
      toast.error(t('support.validation_consent_required'));
      return;
    }
    setIsSubmitting(true);
    try {
      // Encoding happens inside the submitting state: a multi-MB file takes long
      // enough that the button must already be disabled and spinning.
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
      if (axios.isAxiosError(err) && err.response?.status === 503) {
        toast.error(t('support.toast_unavailable'), { description: t('support.toast_unavailable_desc') });
      } else if (axios.isAxiosError(err) && err.response?.status === 429) {
        toast.error(t('support.toast_rate_limited'), {
          description: t('support.toast_rate_limited_desc'),
        });
      } else if (axios.isAxiosError(err) && err.response?.status === 413) {
        // The server's body limit, not its attachment check — a payload this far
        // over the cap never reaches the handler's specific error codes.
        toast.error(
          t('support.validation_attachment_size', { size: formatBytes(config.maxTotalBytes) }),
        );
      } else if (
        axios.isAxiosError(err) &&
        err.response?.status === 400 &&
        typeof err.response.data?.error === 'string' &&
        err.response.data.error.startsWith('ATTACHMENT_')
      ) {
        // Server-side attachment rejection the client-side check didn't catch
        // (e.g. limits lowered since the config was cached). Its message names
        // the offending file, so surface it rather than a generic failure.
        toast.error(t('support.toast_attachment_rejected'), {
          description: err.response.data.message,
        });
      } else {
        toast.error(t('support.toast_error'), { description: t('support.toast_error_desc') });
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
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              disabled={isSubmitting}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-email">{t('support.label_email')}</Label>
            <Input
              id="support-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={320}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-phone">{t('support.label_phone')}</Label>
            <Input
              id="support-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={20}
              disabled={isSubmitting}
            />
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
              onChange={(e) => setDetails(e.target.value)}
              placeholder={t('support.placeholder_details')}
              maxLength={5000}
              rows={5}
              disabled={isSubmitting}
              required
            />
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
              accept={config.allowedTypes.join(',')}
              onChange={handleFilesSelected}
              disabled={isSubmitting || attachments.length >= config.maxFiles}
              className="sr-only"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isSubmitting || attachments.length >= config.maxFiles}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-60"
            >
              <Paperclip className="h-4 w-4" />
              {t('support.attachments_add')}
            </button>
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
          <div className="flex items-start gap-2">
            <Checkbox
              id="support-consent"
              checked={consent}
              onCheckedChange={(checked) => setConsent(checked === true)}
              disabled={isSubmitting}
            />
            <Label htmlFor="support-consent" className="text-sm font-normal leading-snug">
              {t('support.consent_text')}
            </Label>
          </div>
          <DialogFooter>
            <button
              type="submit"
              disabled={!canSubmit}
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
