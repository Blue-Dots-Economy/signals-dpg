import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import axios from 'axios';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { submitSupport } from '@/lib/support-api';

interface SupportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SupportDialog({ open, onOpenChange }: SupportDialogProps) {
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reset = () => {
    setSubject('');
    setMessage('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      toast.error(t('support.validation_message_required'));
      return;
    }
    setIsSubmitting(true);
    try {
      await submitSupport({ subject: subject.trim() || undefined, message: message.trim() });
      toast.success(t('support.toast_sent'), { description: t('support.toast_sent_desc') });
      reset();
      onOpenChange(false);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 503) {
        toast.error(t('support.toast_unavailable'), { description: t('support.toast_unavailable_desc') });
      } else {
        toast.error(t('support.toast_error'), { description: t('support.toast_error_desc') });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('support.dialog_title')}</DialogTitle>
          <DialogDescription>{t('support.dialog_desc')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="support-subject">{t('support.label_subject')}</Label>
            <Input
              id="support-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('support.placeholder_subject')}
              maxLength={200}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="support-message">{t('support.label_message')}</Label>
            <Textarea
              id="support-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('support.placeholder_message')}
              maxLength={5000}
              rows={5}
              disabled={isSubmitting}
              required
            />
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
      </DialogContent>
    </Dialog>
  );
}
