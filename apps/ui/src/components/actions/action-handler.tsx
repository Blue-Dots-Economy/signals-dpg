import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { DotActionSchema } from '@/engine/types';
import { ActionModal } from './action-modal';
import { GuardianOtpDialog } from './guardian-otp-dialog';
import { GuardianOtpPurpose, type GuardianPurpose } from '@/components/consent/u18/guardian-otp-purpose';
import { ActionAbortedError } from '@/lib/action-abort';
import { apiErrorMessage, readApiError } from '@/lib/api-error';
import { resolveRefs } from '@/engine/schema/resolve-schema';
import { splitServerFieldErrors } from '@/components/forms/field-error-message';
import { useGuardianOtpGate } from '@/hooks/use-guardian-otp-gate';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

/**
 * Turn a failed action submission into a user-facing toast. Suppresses its
 * output entirely for an ActionAbortedError (the caller already showed a
 * tailored message) and maps a draft/non-live source profile to a helpful
 * "complete your profile" prompt instead of the generic error.
 */
function showActionError(err: unknown, t: TFunction): void {
  if (err instanceof ActionAbortedError) return;
  const code = (err as { code?: string })?.code;
  if (code === 'PROFILE_NOT_LIVE') {
    toast.warning(t('actions.profile_not_live_title'), {
      description: t('actions.profile_not_live_desc'),
    });
    return;
  }
  toast.error(t('actions.handler_error_title'), {
    description: apiErrorMessage(err, t, t('actions.handler_error_desc')),
  });
}

interface ActionHandlerProps {
  children: (triggerAction: (type: string, schema: DotActionSchema, targetItemId: string) => void) => React.ReactNode;
  onActionSubmit?: (
    actionType: string,
    actionSchema: DotActionSchema,
    formData: Record<string, unknown>,
    targetItemId: string,
    /**
     * Guardian OTP, set only when retrying from `GuardianOtpDialog` after a
     * `GUARDIAN_OTP_REQUIRED` error (a minor ward).
     */
    guardianOtp?: string
  ) => Promise<void> | void;
  /**
   * A minor ward on a guardian-gated domain: confirm before submitting, so
   * the guardian OTP is not sent until the ward opts in.
   */
  guardianConfirmRequired?: boolean;
}

/** State for a pending action that's mid guardian-OTP challenge/response. */
interface GuardianChallenge {
  type: string;
  schema: DotActionSchema;
  targetItemId: string;
  formData: Record<string, unknown>;
}

export function ActionHandler({ children, onActionSubmit, guardianConfirmRequired }: ActionHandlerProps) {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const [activeAction, setActiveAction] = React.useState<{
    type: string;
    schema: DotActionSchema;
    targetItemId: string;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  // The form stays mounted until the submit succeeds; while a guardian dialog
  // is up it is hidden and reopened with `draft` on cancel or failure.
  const [modalHidden, setModalHidden] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, unknown> | undefined>();
  // The server's per-field messages for the open form, from its last failed submit.
  const [serverErrors, setServerErrors] = React.useState<Record<string, string> | undefined>();
  const closeModal = React.useCallback(() => {
    setActiveAction(null);
    setModalHidden(false);
    setDraft(undefined);
    setServerErrors(undefined);
  }, []);
  // An action that returns GUARDIAN_OTP_REQUIRED is stashed and replayed with
  // the guardian's code.
  const gate = useGuardianOtpGate<GuardianChallenge>(async (c, otp) => {
    await onActionSubmit?.(c.type, c.schema, c.formData, c.targetItemId, otp);
    closeModal();
  });
  // Deferred submit awaiting the ward's guardian-OTP confirmation.
  const [pendingGuardianConfirm, setPendingGuardianConfirm] = React.useState<
    { run: () => void; purpose: GuardianPurpose } | null
  >(null);

  const triggerAction = React.useCallback(
    (type: string, schema: DotActionSchema, targetItemId: string) => {
      if (!schema.requirement_schema) {
        handleDirectSubmit(type, schema, targetItemId);
        return;
      }
      setActiveAction({ type, schema, targetItemId });
    },
    []
  );

  /**
   * Returns true on success. On `GUARDIAN_OTP_REQUIRED` stashes the
   * submission, opens `GuardianOtpDialog` and returns false with no toast.
   * Other errors rethrow.
   */
  const submitWithGuardianGate = async (
    type: string,
    schema: DotActionSchema,
    formData: Record<string, unknown>,
    targetItemId: string
  ): Promise<boolean> => {
    try {
      await onActionSubmit?.(type, schema, formData, targetItemId);
      return true;
    } catch (err) {
      if (gate.captureIfGuardianRequired(err, { type, schema, targetItemId, formData })) {
        return false;
      }
      throw err;
    }
  };

  // Success toasts belong to `onActionSubmit`; this handles errors only.
  const performSubmit = async (
    type: string,
    schema: DotActionSchema,
    formData: Record<string, unknown>,
    targetItemId: string,
  ): Promise<'ok' | 'guardian' | 'error'> => {
    setLoading(true);
    setServerErrors(undefined);
    try {
      return (await submitWithGuardianGate(type, schema, formData, targetItemId)) ? 'ok' : 'guardian';
    } catch (err) {
      // Messages the form can show go under their fields; the toast covers the rest.
      const { fields } = readApiError(err);
      const req = schema.requirement_schema;
      if (fields && Object.keys(fields).length > 0 && req) {
        const formSchema = '$ref' in req ? await resolveRefs(req).catch(() => null) : req;
        const { onForm, offForm } = splitServerFieldErrors(fields, formSchema, formData);
        if (Object.keys(onForm).length > 0) setServerErrors(onForm);
        if (offForm.length === 0) return 'error';
      }
      showActionError(err, t);
      return 'error';
    } finally {
      setLoading(false);
    }
  };

  const purposeForType = (type: string): GuardianPurpose =>
    type === 'connect' ? { kind: 'connect' } : { kind: 'apply' };

  // For a minor, defer the submit behind the guardian-confirm step.
  const gateSubmit = (run: () => void, purpose: GuardianPurpose) => {
    if (guardianConfirmRequired) setPendingGuardianConfirm({ run, purpose });
    else run();
  };

  const handleDirectSubmit = (
    type: string,
    schema: DotActionSchema,
    targetItemId: string
  ) => {
    gateSubmit(() => { void performSubmit(type, schema, {}, targetItemId); }, purposeForType(type));
  };

  const handleModalSubmit = (formData: Record<string, unknown>) => {
    if (!activeAction) return;
    const { type, schema, targetItemId } = activeAction;
    setDraft(formData);
    // Hide the form behind the confirm/OTP dialog so only one is visible.
    if (guardianConfirmRequired) setModalHidden(true);
    gateSubmit(() => {
      void performSubmit(type, schema, formData, targetItemId).then((outcome) => {
        if (outcome === 'ok') closeModal();
        else if (outcome === 'guardian') setModalHidden(true);
        else setModalHidden(false);
      });
    }, purposeForType(type));
  };

  return (
    <>
      {children(triggerAction)}
      {activeAction && (
        <ActionModal
          open={!modalHidden}
          onOpenChange={(open) => !open && closeModal()}
          actionSchema={activeAction.schema}
          initialData={draft}
          onSubmit={handleModalSubmit}
          loading={loading}
          minor={guardianConfirmRequired}
          {...(serverErrors ? { serverErrors } : {})}
        />
      )}
      <GuardianOtpDialog
        open={!!gate.challenge}
        onOpenChange={(open) => {
          if (open) return;
          gate.setChallenge(null);
          setModalHidden(false);
        }}
        onSubmitOtp={gate.submitOtp}
        purpose={
          gate.challenge
            ? gate.challenge.type === 'connect'
              ? { kind: 'connect' }
              : { kind: 'apply' }
            : undefined
        }
        onLogout={() => { void signOut(); }}
      />
      <Dialog
        open={!!pendingGuardianConfirm}
        onOpenChange={(open) => {
          if (open) return;
          setPendingGuardianConfirm(null);
          setModalHidden(false);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('actions.guardian_confirm_title')}</DialogTitle>
            <DialogDescription>{t('actions.guardian_confirm_desc')}</DialogDescription>
          </DialogHeader>
          {pendingGuardianConfirm && <GuardianOtpPurpose purpose={pendingGuardianConfirm.purpose} />}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingGuardianConfirm(null);
                setModalHidden(false);
              }}
            >
              {t('actions.guardian_confirm_cancel')}
            </Button>
            <Button
              onClick={() => {
                const run = pendingGuardianConfirm?.run;
                setPendingGuardianConfirm(null);
                run?.();
              }}
            >
              {t('actions.guardian_confirm_proceed')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
