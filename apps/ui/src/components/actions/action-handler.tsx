import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { DotActionSchema } from '@/engine/types';
import { ActionModal } from './action-modal';
import { GuardianOtpDialog } from './guardian-otp-dialog';
import { ActionAbortedError } from '@/lib/action-abort';
import { guardianOtpErrorFromThrown } from '@/lib/action-api';
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
function showActionError(err: unknown, t: (key: string) => string): void {
  if (err instanceof ActionAbortedError) return;
  const code = (err as { code?: string })?.code;
  if (code === 'PROFILE_NOT_LIVE') {
    toast.warning(t('actions.profile_not_live_title'), {
      description: t('actions.profile_not_live_desc'),
    });
    return;
  }
  toast.error(t('actions.handler_error_title'), {
    description: t('actions.handler_error_desc'),
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
     * Guardian OTP to resubmit the SAME action with, after a prior call
     * without it returned a `GUARDIAN_OTP_REQUIRED` per-item error (a minor
     * ward). Adult ward calls never receive this — it's only set when
     * `ActionHandler` is retrying from `GuardianOtpDialog`.
     */
    guardianOtp?: string
  ) => Promise<void> | void;
  /**
   * When true (a minor ward on a guardian-gated domain), a confirm step is
   * shown BEFORE submitting — "an OTP will be sent to your guardian, proceed?"
   * — so the guardian OTP isn't dispatched until the ward opts in.
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
  const [guardianChallenge, setGuardianChallenge] = React.useState<GuardianChallenge | null>(null);
  // Deferred submit awaiting the ward's "send OTP to my guardian?" confirmation.
  const [pendingGuardianConfirm, setPendingGuardianConfirm] = React.useState<(() => void) | null>(null);

  const triggerAction = React.useCallback(
    (type: string, schema: DotActionSchema, targetItemId: string) => {
      if (!schema.requirement_schema) {
        // No form needed, submit directly
        handleDirectSubmit(type, schema, targetItemId);
        return;
      }
      setActiveAction({ type, schema, targetItemId });
    },
    []
  );

  /**
   * Submits the action. If the (adult) result succeeds normally, returns
   * true. If it fails with `GUARDIAN_OTP_REQUIRED` (a minor ward), stashes
   * everything needed to resubmit and opens `GuardianOtpDialog`, returning
   * false without surfacing an error toast. Any other error rethrows for the
   * caller's existing catch block.
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
      if (guardianOtpErrorFromThrown(err) === 'GUARDIAN_OTP_REQUIRED') {
        setGuardianChallenge({ type, schema, targetItemId, formData });
        return false;
      }
      throw err;
    }
  };

  // Do the actual submit. Success messaging is owned by the onActionSubmit
  // callback (action-specific toast); we only handle errors + modal close here.
  const performSubmit = async (
    type: string,
    schema: DotActionSchema,
    formData: Record<string, unknown>,
    targetItemId: string,
  ) => {
    setLoading(true);
    try {
      await submitWithGuardianGate(type, schema, formData, targetItemId);
    } catch (err) {
      showActionError(err, t);
    } finally {
      setLoading(false);
    }
  };

  // Gate the submit behind the guardian-confirm step for a minor: stash the
  // deferred submit and show the confirm; otherwise run immediately.
  const gateSubmit = (run: () => void) => {
    if (guardianConfirmRequired) setPendingGuardianConfirm(() => run);
    else run();
  };

  const handleDirectSubmit = (
    type: string,
    schema: DotActionSchema,
    targetItemId: string
  ) => {
    gateSubmit(() => { void performSubmit(type, schema, {}, targetItemId); });
  };

  const handleModalSubmit = (formData: Record<string, unknown>) => {
    if (!activeAction) return;
    const { type, schema, targetItemId } = activeAction;
    // Close the form first so only one dialog (confirm or OTP) is visible.
    setActiveAction(null);
    gateSubmit(() => { void performSubmit(type, schema, formData, targetItemId); });
  };

  const handleGuardianOtpSubmit = async (otp: string) => {
    if (!guardianChallenge) return;
    const { type, schema, formData, targetItemId } = guardianChallenge;
    await onActionSubmit?.(type, schema, formData, targetItemId, otp);
    setGuardianChallenge(null);
    // Success toast is owned by the onActionSubmit callback (action-specific).
  };

  return (
    <>
      {children(triggerAction)}
      {activeAction && (
        <ActionModal
          open={!!activeAction}
          onOpenChange={(open) => !open && setActiveAction(null)}
          actionSchema={activeAction.schema}
          onSubmit={handleModalSubmit}
          loading={loading}
        />
      )}
      <GuardianOtpDialog
        open={!!guardianChallenge}
        onOpenChange={(open) => !open && setGuardianChallenge(null)}
        onSubmitOtp={handleGuardianOtpSubmit}
        onLogout={() => { void signOut(); }}
      />
      <Dialog
        open={!!pendingGuardianConfirm}
        onOpenChange={(open) => { if (!open) setPendingGuardianConfirm(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('actions.guardian_confirm_title')}</DialogTitle>
            <DialogDescription>{t('actions.guardian_confirm_desc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingGuardianConfirm(null)}>
              {t('actions.guardian_confirm_cancel')}
            </Button>
            <Button
              onClick={() => {
                const run = pendingGuardianConfirm;
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
