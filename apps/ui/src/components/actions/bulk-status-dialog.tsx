import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Action } from '@/lib/action-api';
import { useUpdateActionStatusBulk } from '@/hooks/use-actions';
import { useNetworkConfig } from '@/hooks/use-network-config';
import { ConsentCheckbox } from './consent-checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface BulkStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected actions to update. */
  actions: Action[];
  /** Target status: 'accepted' | 'rejected' | 'cancelled'. */
  targetStatus: string;
  /** Called after the bulk call settles (so the page can clear selection). */
  onSettled: (succeeded: number, total: number, failedIds: string[]) => void;
}

export function BulkStatusDialog({
  open,
  onOpenChange,
  actions,
  targetStatus,
  onSettled,
}: BulkStatusDialogProps) {
  const { t } = useTranslation();
  const { mutateAsync, isPending } = useUpdateActionStatusBulk();
  const [remarks, setRemarks] = React.useState('');
  const [consentChecked, setConsentChecked] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setRemarks('');
      setConsentChecked(false);
    }
  }, [open]);

  // Resolve consent text from the first action's network config (the selection
  // is homogeneous in practice — same action_type within a tab).
  const first = actions[0] ?? null;
  const { data: networkConfig } = useNetworkConfig(first?.target_item_network ?? null);

  const interaction = React.useMemo(() => {
    if (!networkConfig || !first) return null;
    const actionDef = networkConfig.actions?.[first.action_type];
    if (!actionDef) return null;
    return (
      (actionDef.interactions ?? []).find((i) => {
        const fromNet = i.from_network ?? networkConfig.id;
        const toNet = i.to_network ?? networkConfig.id;
        return (
          fromNet === first.source_item_network &&
          i.from_domain === first.source_item_domain &&
          toNet === first.target_item_network &&
          i.to_domain === first.target_item_domain
        );
      }) ?? null
    );
  }, [networkConfig, first]);

  const revealStatuses = interaction?.reveals_pii_on_status ?? [];
  const consentText = (interaction?.consent_text_receiver ?? '').trim();
  const requiresConsent = revealStatuses.includes(targetStatus) && consentText !== '';

  const titleKey =
    targetStatus === 'accepted'
      ? 'actions.bulk_confirm_accept_title'
      : targetStatus === 'rejected'
        ? 'actions.bulk_confirm_reject_title'
        : 'actions.bulk_confirm_cancel_title';

  const handleConfirm = async () => {
    const ids = actions.map((a) => a.action_id);
    const sharedRemarks = remarks.trim();
    const payloads = ids.map((action_id) => ({
      action_id,
      action_status: targetStatus,
      ...(requiresConsent
        ? { consent: { acknowledged: true as const, text: consentText } }
        : sharedRemarks
          ? { remarks: sharedRemarks }
          : {}),
    }));

    try {
      const env = await mutateAsync(payloads);
      const failedIdxs = new Set(
        env.results.filter((r) => r.status === 'error').map((r) => r.index),
      );
      const failedIds = ids.filter((_, i) => failedIdxs.has(i));
      if (env.summary.failed === 0) {
        toast.success(t('actions.bulk_done_all', { count: env.summary.succeeded }));
      } else {
        toast.warning(
          t('actions.bulk_done_partial', {
            succeeded: env.summary.succeeded,
            total: env.summary.total,
          }),
        );
      }
      onOpenChange(false);
      onSettled(env.summary.succeeded, env.summary.total, failedIds);
    } catch (err) {
      toast.error(t('actions.bulk_failed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const confirmDisabled = isPending || (requiresConsent && !consentChecked) || actions.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isPending) return; // don't allow dismiss mid-submit
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[480px] gap-0 p-6">
        <h2 className="text-lg font-bold">{t(titleKey, { count: actions.length })}</h2>
        <div className="py-4">
          {requiresConsent ? (
            <ConsentCheckbox
              text={consentText}
              checked={consentChecked}
              onCheckedChange={setConsentChecked}
            />
          ) : targetStatus === 'rejected' || targetStatus === 'cancelled' ? (
            <div className="space-y-2">
              <Label htmlFor="bulk-reason">{t('actions.bulk_reason_label')}</Label>
              <Textarea
                id="bulk-reason"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder={t('actions.bulk_reason_placeholder')}
              />
            </div>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={confirmDisabled} className="min-w-[120px] font-semibold">
            {isPending ? t('actions.btn_updating') : t('actions.bulk_confirm_btn')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
