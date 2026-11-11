import { useTranslation } from 'react-i18next';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';

interface MinorBulkNoteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Shown instead of the guardian OTP dialog when a minor's bulk send/accept is refused. */
export function MinorBulkNoteDialog({ open, onOpenChange }: MinorBulkNoteDialogProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('actions.minor_bulk_title')}
      contentClassName="sm:max-w-[420px]"
    >
      <div className="flex flex-col gap-4 p-6" data-testid="minor-bulk-note">
        <h2 className="text-lg font-bold">{t('actions.minor_bulk_title')}</h2>
        <p className="text-sm text-muted-foreground">{t('actions.minor_bulk_body')}</p>
        <div className="flex justify-end">
          <Button onClick={() => onOpenChange(false)}>{t('actions.minor_bulk_ok')}</Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
