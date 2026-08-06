import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  updateActionStatus,
  type Action,
  type UpdateActionStatusPayload,
} from '@/lib/action-api';
import { useGuardianOtpGate } from '@/hooks/use-guardian-otp-gate';
import { ActionModalHeader } from './action-modal-header';
import { ConsentCheckbox } from './consent-checkbox';
import { GuardianOtpDialog } from './guardian-otp-dialog';
import { getActionDisplay } from '@/lib/action-display';
import { renderConsentStatement } from '@/lib/consent-copy';
import { cn } from '@/lib/utils';
import { useNetworkConfig } from '@/hooks/use-network-config';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { useNetworkTheme } from '@/theme/theme-provider';

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

import { useUpdateActionStatus, actionKeys } from '@/hooks/use-actions';
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
  const queryClient = useQueryClient();
  const { mutate: updateStatus, isPending } = useUpdateActionStatus();

  const successTitleByStatus: Record<string, string> = {
    accepted: t('actions.toast_status_accepted_title'),
    rejected: t('actions.toast_status_rejected_title'),
    completed: t('actions.toast_status_completed_title'),
    cancelled: t('actions.toast_status_cancelled_title'),
  };

  // Minor-ward guardian OTP: an update-status that returns GUARDIAN_OTP_REQUIRED
  // is stashed and replayed with the guardian's code (see useGuardianOtpGate).
  const gate = useGuardianOtpGate<UpdateActionStatusPayload>(async (payload, otp) => {
    await updateActionStatus(payload, otp);
    queryClient.invalidateQueries({ queryKey: actionKeys.all });
    toast.success(successTitleByStatus[payload.action_status] ?? t('actions.toast_status_accepted_title'), {
      description: t('actions.toast_updated_desc'),
    });
    onOpenChange(false);
  });

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
      gate.setChallenge(null);
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

  const { config } = useConsentConfig();
  const { brand } = useNetworkTheme();

  if (!action) return null;

  // Determine whether consent is required for this status transition.
  const revealStatuses = interaction?.reveals_pii_on_status ?? [];
  const requiresConsent = revealStatuses.includes(targetStatus);
  const acceptDoc = config?.actions?.[action.action_type]?.accept;
  const acceptVersion = acceptDoc?.versions.find((v) => v.version === acceptDoc.current_version);
  // Accept stage: the accepter shares details with whoever initiated the
  // request, so the counterparty noun is the source (requester) domain.
  const consentText = renderConsentStatement(
    acceptVersion?.statement ?? '',
    action.source_item_domain,
  );

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
        ? {
            consent: {
              acknowledged: true as const,
              version: acceptDoc?.current_version ?? 1,
              brand: brand === 'standard' ? null : brand,
            },
          }
        : remarks.trim()
          ? { remarks: remarks.trim() }
          : {}),
    };

    updateStatus(payload, {
      onSuccess: () => {
        toast.success(successTitleByStatus[targetStatus] ?? t('actions.toast_status_accepted_title'), {
          description: t('actions.toast_updated_desc'),
        });
        onOpenChange(false);
      },
      onError: (error: Error) => {
        // A minor ward: the accept/reject/etc. requires guardian confirmation.
        // Stash the exact payload and open the OTP challenge instead of the
        // generic error toast — adults never see a GUARDIAN_OTP_* code here.
        if (gate.captureIfGuardianRequired(error, payload)) {
          // Close the accept/reject dialog in favor of the OTP challenge — the
          // component stays mounted (`action` is unaffected), so the dialog
          // (driven by gate.challenge) keeps working after this.
          onOpenChange(false);
          return;
        }
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

  const guardianOtpDialog = (
    <GuardianOtpDialog
      open={!!gate.challenge}
      onOpenChange={(o) => !o && gate.setChallenge(null)}
      onSubmitOtp={gate.submitOtp}
      purpose={{ kind: 'accept' }}
    />
  );

  if (isMobile) {
    return (
      <>
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent className="max-h-[90dvh] overflow-hidden p-0">
            <div className="px-6 pt-6">{header}</div>
            <div className="px-6 pb-4 overflow-y-auto">{formContent}</div>
            <div className="border-t px-6 py-4">{footer}</div>
          </DrawerContent>
        </Drawer>
        {guardianOtpDialog}
      </>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[520px] max-h-[90dvh] overflow-y-auto gap-0 p-6">
          {header}
          <div className="py-4">{formContent}</div>
          {footer}
        </DialogContent>
      </Dialog>
      {guardianOtpDialog}
    </>
  );
}
