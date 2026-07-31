import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  guardianOtpErrorOf,
  type Action,
  type UpdateActionStatusPayload,
} from '@/lib/action-api';
import { BulkSingleError } from '@/lib/bulk';
import { useAuth } from '@/contexts/auth-context';
import { GuardianOtpDialog } from './guardian-otp-dialog';
import { useUpdateActionStatusBulk } from '@/hooks/use-actions';
import { useNetworkConfig } from '@/hooks/use-network-config';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { useNetworkTheme } from '@/theme/theme-provider';
import { ConsentCheckbox } from './consent-checkbox';
import {
  renderConsentStatementWithNoun,
  formatBatchCounterpartyNoun,
} from '@/lib/consent-copy';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
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
  const { signOut } = useAuth();
  const { mutateAsync, isPending } = useUpdateActionStatusBulk();
  const [remarks, setRemarks] = React.useState('');
  const [consentChecked, setConsentChecked] = React.useState(false);

  // Minor acceptor doing a bulk accept (#393): gated rows come back
  // GUARDIAN_OTP_REQUIRED after one OTP is sent to the guardian. Stash the
  // gated payloads to resubmit with the single code — one guardian OTP dialog
  // for the batch, mirroring the initiator-side bulk flow on the home page.
  const [bulkGuardianChallenge, setBulkGuardianChallenge] = React.useState<{
    payloads: UpdateActionStatusPayload[];
    // Non-guardian failures from a mixed batch, reselected once the OTP dialog
    // resolves (they still need a retry).
    otherFailedIds?: string[];
  } | null>(null);

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

  const { config } = useConsentConfig();
  const { brand } = useNetworkTheme();

  const revealStatuses = interaction?.reveals_pii_on_status ?? [];
  const requiresConsent = revealStatuses.includes(targetStatus);
  const acceptDoc = first ? config?.actions?.[first.action_type]?.accept : undefined;
  const acceptVersion = acceptDoc?.versions.find((v) => v.version === acceptDoc.current_version);
  // Bulk accept: the accepter shares details with the requester(s). The batch can
  // span more than one source domain, so name every distinct one (e.g. "seeker /
  // provider") rather than a single possibly-wrong party.
  const consentText = renderConsentStatementWithNoun(
    acceptVersion?.statement ?? '',
    formatBatchCounterpartyNoun(actions.map((a) => a.source_item_domain)),
  );

  const titleKey =
    targetStatus === 'accepted'
      ? 'actions.bulk_confirm_accept_title'
      : targetStatus === 'rejected'
        ? 'actions.bulk_confirm_reject_title'
        : targetStatus === 'completed'
          ? 'actions.bulk_confirm_complete_title'
          : 'actions.bulk_confirm_cancel_title';

  const handleConfirm = async () => {
    const ids = actions.map((a) => a.action_id);
    const sharedRemarks = remarks.trim();
    const payloads = ids.map((action_id) => ({
      action_id,
      action_status: targetStatus,
      ...(requiresConsent
        ? {
            consent: {
              acknowledged: true as const,
              version: acceptDoc?.current_version ?? 1,
              brand: brand === 'standard' ? null : brand,
            },
          }
        : sharedRemarks
          ? { remarks: sharedRemarks }
          : {}),
    }));

    try {
      const env = await mutateAsync({ payloads });
      if (env.summary.failed === 0) {
        toast.success(t('actions.bulk_done_all', { count: env.summary.succeeded }));
        onOpenChange(false);
        onSettled(env.summary.succeeded, env.summary.total, []);
        return;
      }

      const failedResults = env.results.filter((r) => r.status === 'error');
      const guardianResults = failedResults.filter(
        (r) => guardianOtpErrorOf(r) === 'GUARDIAN_OTP_REQUIRED',
      );
      // Any GUARDIAN_OTP_REQUIRED failure means a code was already sent to the
      // guardian — open ONE dialog for those rows and resubmit the batch with
      // the code, rather than surfacing the raw error. Non-guardian failures
      // ride along and are reselected once the dialog resolves.
      if (guardianResults.length > 0) {
        const otherFailedIds = failedResults
          .filter((r) => guardianOtpErrorOf(r) !== 'GUARDIAN_OTP_REQUIRED')
          .map((r) => ids[r.index]);
        setBulkGuardianChallenge({
          payloads: guardianResults.map((r) => payloads[r.index]),
          otherFailedIds: otherFailedIds.length > 0 ? otherFailedIds : undefined,
        });
        onOpenChange(false); // the guardian OTP dialog owns the resubmit
        return;
      }

      const failedIds = ids.filter((_, i) =>
        failedResults.some((r) => r.index === i),
      );
      toast.warning(
        t('actions.bulk_done_partial', {
          succeeded: env.summary.succeeded,
          total: env.summary.total,
        }),
      );
      onOpenChange(false);
      onSettled(env.summary.succeeded, env.summary.total, failedIds);
    } catch (err) {
      toast.error(t('actions.bulk_failed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const confirmDisabled = isPending || (requiresConsent && !consentChecked) || actions.length === 0;

  // One guardian OTP dialog for a MINOR acceptor's BULK accept (#393). The code
  // resubmits the stashed payloads via updateActionStatusBulk with the OTP.
  const bulkGuardianOtpModal = (
    <GuardianOtpDialog
      open={!!bulkGuardianChallenge}
      onOpenChange={(next) => {
        if (!next) setBulkGuardianChallenge(null);
      }}
      onLogout={() => {
        void signOut();
      }}
      onSubmitOtp={async (otp) => {
        const ch = bulkGuardianChallenge;
        if (!ch) return;
        const env2 = await mutateAsync({ payloads: ch.payloads, guardianOtp: otp });
        if (env2.summary.failed === 0) {
          const otherFailedIds = ch.otherFailedIds ?? [];
          const total = env2.summary.succeeded + otherFailedIds.length;
          setBulkGuardianChallenge(null);
          if (otherFailedIds.length > 0) {
            // Mixed batch: gated rows went through, others failed for a
            // non-guardian reason — keep those selected for a retry.
            toast.warning(
              t('actions.bulk_done_partial', { succeeded: env2.summary.succeeded, total }),
            );
          } else {
            toast.success(t('actions.bulk_done_all', { count: env2.summary.succeeded }));
          }
          onSettled(env2.summary.succeeded, total, otherFailedIds);
          return;
        }
        // Still failing (wrong/expired code, throttled …) — throw a classified
        // error so GuardianOtpDialog shows the inline message and stays open.
        const firstFail = env2.results.find((r) => r.status === 'error');
        const code = guardianOtpErrorOf(firstFail) ?? 'GUARDIAN_OTP_INVALID';
        throw new BulkSingleError(code, firstFail?.message ?? 'Guardian confirmation failed', 422);
      }}
    />
  );

  return (
    <>
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isPending) return; // don't allow dismiss mid-submit
        onOpenChange(next);
      }}
      title={t(titleKey, { count: actions.length })}
      contentClassName="sm:max-w-[480px]"
    >
      <div className="flex flex-col gap-0 overflow-y-auto p-6">
        <h2 className="text-lg font-bold">{t(titleKey, { count: actions.length })}</h2>
        <div className="py-4">
          {requiresConsent ? (
            <ConsentCheckbox
              text={consentText}
              checked={consentChecked}
              onCheckedChange={setConsentChecked}
            />
          ) : targetStatus === 'rejected' || targetStatus === 'cancelled' || targetStatus === 'completed' ? (
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
      </div>
    </ResponsiveDialog>
    {bulkGuardianOtpModal}
    </>
  );
}
