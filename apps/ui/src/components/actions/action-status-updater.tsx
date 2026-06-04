import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Action, UpdateActionStatusPayload } from '@/lib/action-api';
import { ActionModalHeader } from './action-modal-header';
import { ConsentCheckbox } from './consent-checkbox';
import { getActionDisplay } from '@/lib/action-display';
import { cn } from '@/lib/utils';
import { useNetworkConfig } from '@/hooks/use-network-config';

// Desktop: Dialog
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

// Mobile: Drawer
import {
  Drawer,
  DrawerContent,
} from '@/components/ui/drawer';

import { useUpdateActionStatus } from '@/hooks/use-actions';
import { toast } from 'sonner';

interface ActionStatusUpdaterProps {
  action: Action | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The status the user intends to transition to, pre-selected by the action-card button. */
  suggestedStatus?: string;
}

export function ActionStatusUpdater({
  action,
  open,
  onOpenChange,
  suggestedStatus,
}: ActionStatusUpdaterProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { mutate: updateStatus, isPending } = useUpdateActionStatus();

  const statusLabels: Record<string, string> = {
    accepted: t('actions.status_label_accepted'),
    rejected: t('actions.status_label_rejected'),
    completed: t('actions.status_label_completed'),
    cancelled: t('actions.status_label_cancelled'),
  };

  // Friendly subtitles per resolved status — drives the colored header band.
  const STATUS_SUBTITLES: Record<string, string> = {
    accepted: t('actions.status_subtitle_accepted'),
    rejected: t('actions.status_subtitle_rejected'),
    cancelled: t('actions.status_subtitle_cancelled'),
    completed: t('actions.status_subtitle_completed'),
  };

  const targetStatus = suggestedStatus ?? '';
  const [consentChecked, setConsentChecked] = React.useState(false);
  const [remarks, setRemarks] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setConsentChecked(false);
      setRemarks('');
    }
  }, [open]);

  // Resolve the interaction from the network config so consent fields are
  // always available without prop drilling from the action list.
  const { data: networkConfig } = useNetworkConfig(action?.target_item_network ?? null);

  const interaction = React.useMemo(() => {
    if (!networkConfig || !action) return null;
    const actionDef = networkConfig.actions?.[action.action_type];
    if (!actionDef) return null;
    return (
      (actionDef.interactions ?? []).find((i) => {
        const fromNet = i.from_network ?? networkConfig.id;
        const toNet = i.to_network ?? networkConfig.id;
        const fromItems = i.from_items ?? [];
        const toItems = i.to_items ?? [];
        return (
          fromNet === action.source_item_network &&
          i.from_domain === action.source_item_domain &&
          (fromItems.length === 0 || fromItems.includes(action.source_item_type)) &&
          toNet === action.target_item_network &&
          i.to_domain === action.target_item_domain &&
          (toItems.length === 0 || toItems.includes(action.target_item_type))
        );
      }) ?? null
    );
  }, [networkConfig, action]);

  // Reset form state when the resolved interaction changes mid-session
  // (e.g. networkConfig finishes loading after the modal opened) so a stale
  // consentChecked from the pre-load render can't bypass a freshly-required gate.
  React.useEffect(() => {
    setConsentChecked(false);
    setRemarks('');
  }, [interaction]);

  if (!action) return null;

  // Determine whether consent is required for this status transition.
  const revealStatuses = interaction?.reveals_pii_on_status ?? [];
  const consentText = (interaction?.consent_text_receiver ?? '').trim();
  const requiresConsent = revealStatuses.includes(targetStatus) && consentText !== '';

  const handleSubmit = () => {
    if (!targetStatus) {
      toast.error(t('actions.toast_no_status_title'), {
        description: t('actions.toast_no_status_desc'),
      });
      return;
    }

    const payload: UpdateActionStatusPayload = {
      action_id: action.action_id,
      action_status: targetStatus,
      ...(requiresConsent
        ? { consent: { acknowledged: true as const, text: consentText } }
        : remarks.trim()
          ? { remarks: remarks.trim() }
          : {}),
    };

    const successTitleByStatus: Record<string, string> = {
      accepted: t('actions.toast_status_accepted_title'),
      rejected: t('actions.toast_status_rejected_title'),
      completed: t('actions.toast_status_completed_title'),
      cancelled: t('actions.toast_status_cancelled_title'),
    };

    updateStatus(payload, {
      onSuccess: () => {
        toast.success(successTitleByStatus[targetStatus] ?? t('actions.toast_status_accepted_title'), {
          description: t('actions.toast_updated_desc'),
        });
        onOpenChange(false);
      },
      onError: (error: Error) => {
        toast.error(t('actions.toast_update_failed', { message: error.message }));
      },
    });
  };

  const formContent = (
    <div className="space-y-4">
      {requiresConsent ? (
        <ConsentCheckbox
          text={consentText}
          checked={consentChecked}
          onCheckedChange={setConsentChecked}
        />
      ) : (
        <div className="space-y-2">
          <Label htmlFor="action-remarks">{t('actions.remarks_label')}</Label>
          <Textarea
            id="action-remarks"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder={t('actions.remarks_placeholder')}
          />
        </div>
      )}
    </div>
  );

  // Drive the header band from the target status — falls back to the action
  // type when nothing's chosen yet (the typical "first paint").
  const headerKey = targetStatus || action.action_type || 'connect';
  const display = getActionDisplay(headerKey);
  const actionLabel = statusLabels[targetStatus] ?? display.label;
  const subtitle = STATUS_SUBTITLES[targetStatus] ?? t('actions.updater_subtitle_fallback', { actionType: action.action_type ?? 'action' });

  const header = (
    <ActionModalHeader
      actionKey={headerKey}
      title={targetStatus ? t('actions.updater_title_with_status', { actionLabel }) : t('actions.updater_title_default')}
      description={subtitle}
      fromDomain={action.source_item_domain}
      toDomain={action.target_item_domain}
    />
  );

  const footer = (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
        {t('common.cancel')}
      </Button>
      <Button
        onClick={handleSubmit}
        disabled={isPending || !networkConfig || (requiresConsent && !consentChecked)}
        className={cn('min-w-[120px] font-semibold shadow-sm', display.buttonClass)}
      >
        {isPending ? t('actions.btn_updating') : t('actions.btn_submit')}
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90vh] overflow-hidden p-0">
          <div className="px-6 pt-6">{header}</div>
          <div className="px-6 pb-4 overflow-y-auto">{formContent}</div>
          <div className="border-t px-6 py-4">{footer}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto gap-0 p-6">
        {header}
        <div className="py-4">{formContent}</div>
        {footer}
      </DialogContent>
    </Dialog>
  );
}
