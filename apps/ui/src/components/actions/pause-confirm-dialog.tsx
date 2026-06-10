import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface PauseConfirmDialogProps {
  open: boolean;
  /** Number of pending actions (status created or submitted) that will be cancelled. */
  pendingCount: number;
  /** Whether the API call is in progress. */
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PauseConfirmDialog({
  open,
  pendingCount,
  isPending = false,
  onConfirm,
  onCancel,
}: PauseConfirmDialogProps) {
  const { t } = useTranslation();

  const description =
    pendingCount > 0
      ? t('profile.pause_confirm_desc_pending', { count: pendingCount })
      : t('profile.pause_confirm_desc_no_pending');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isPending) return;
        if (!next) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('profile.pause_confirm_title')}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
            className="min-w-[100px]"
          >
            {isPending ? t('profile.pausing') : t('profile.pause_confirm_btn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
