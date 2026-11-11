import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface MinorBulkNoteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Shown instead of a bulk send/accept when bulk is off for minors (#917). */
export function MinorBulkNoteDialog({ open, onOpenChange }: MinorBulkNoteDialogProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('actions.minor_bulk_title')}
      contentClassName="sm:max-w-[440px]"
    >
      <div className="flex flex-col gap-4 p-6" data-testid="minor-bulk-note">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Info className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="text-lg font-bold">{t('actions.minor_bulk_title')}</h2>
        </div>
        <Alert variant="info">
          <Info aria-hidden="true" />
          <AlertDescription className="text-foreground">
            <p>{t('actions.minor_bulk_body')}</p>
            <p className="text-muted-foreground">{t('actions.minor_bulk_hint')}</p>
          </AlertDescription>
        </Alert>
        <div className="flex justify-end">
          <Button onClick={() => onOpenChange(false)}>{t('actions.minor_bulk_ok')}</Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
