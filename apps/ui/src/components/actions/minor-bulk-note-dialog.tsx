import { Trans, useTranslation } from 'react-i18next';
import { Check, ShieldCheck } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface MinorBulkNoteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const STEPS = ['open', 'act', 'guardian'] as const;

/** Shown instead of a bulk send/accept when bulk is off for minors (#917). */
export function MinorBulkNoteDialog({ open, onOpenChange }: MinorBulkNoteDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" data-testid="minor-bulk-note">
        <DialogHeader className="gap-3 text-left">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </span>
          <DialogTitle className="text-2xl font-bold">{t('actions.minor_bulk_title')}</DialogTitle>
          <DialogDescription className="text-base">
            <Trans
              i18nKey="actions.minor_bulk_body"
              components={{ b: <strong className="font-semibold text-foreground" /> }}
            />
          </DialogDescription>
        </DialogHeader>

        <ol className="mt-2">
          {STEPS.map((step, i) => {
            const last = i === STEPS.length - 1;
            return (
              <li key={step} className="relative flex gap-4 pb-5 last:pb-0">
                {!last && (
                  <span
                    aria-hidden="true"
                    className="absolute left-[18px] top-10 bottom-1 border-l-2 border-dashed border-primary/25"
                  />
                )}
                <span
                  className={
                    last
                      ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground'
                      : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary'
                  }
                >
                  {last ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
                </span>
                <div className="min-w-0 pt-1">
                  <p className="font-semibold text-foreground">{t(`actions.minor_bulk_step_${step}_title`)}</p>
                  <p className="text-sm text-muted-foreground">{t(`actions.minor_bulk_step_${step}_desc`)}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <DialogFooter className="mt-2 border-t pt-4">
          <Button onClick={() => onOpenChange(false)}>{t('actions.minor_bulk_ok')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
