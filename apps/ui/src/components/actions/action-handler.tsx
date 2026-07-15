import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { DotActionSchema } from '@/engine/types';
import { ActionModal } from './action-modal';
import { GuardianOtpDialog } from './guardian-otp-dialog';
import { ActionAbortedError } from '@/lib/action-abort';
import { guardianOtpErrorFromThrown } from '@/lib/action-api';
import { toast } from 'sonner';

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
}

/** State for a pending action that's mid guardian-OTP challenge/response. */
interface GuardianChallenge {
  type: string;
  schema: DotActionSchema;
  targetItemId: string;
  formData: Record<string, unknown>;
}

export function ActionHandler({ children, onActionSubmit }: ActionHandlerProps) {
  const { t } = useTranslation();
  const [activeAction, setActiveAction] = React.useState<{
    type: string;
    schema: DotActionSchema;
    targetItemId: string;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [guardianChallenge, setGuardianChallenge] = React.useState<GuardianChallenge | null>(null);

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

  const handleDirectSubmit = async (
    type: string,
    schema: DotActionSchema,
    targetItemId: string
  ) => {
    setLoading(true);
    try {
      const succeeded = await submitWithGuardianGate(type, schema, {}, targetItemId);
      if (succeeded) {
        toast.success(t('actions.handler_completed_title'), {
          description: t('actions.handler_completed_desc'),
        });
      }
    } catch (err) {
      showActionError(err, t);
    } finally {
      setLoading(false);
    }
  };

  const handleModalSubmit = async (formData: Record<string, unknown>) => {
    if (!activeAction) return;
    setLoading(true);
    try {
      const succeeded = await submitWithGuardianGate(
        activeAction.type,
        activeAction.schema,
        formData,
        activeAction.targetItemId
      );
      if (succeeded) {
        toast.success(t('actions.handler_completed_title'), {
          description: t('actions.handler_completed_desc'),
        });
      }
      // Either the action completed, or a guardian OTP challenge opened —
      // either way, close the confirm modal so only one dialog is visible.
      setActiveAction(null);
    } catch (err) {
      // An intentional abort (e.g. draft profile) already showed its own
      // message — just close the form so the toast isn't left behind it.
      if (err instanceof ActionAbortedError) setActiveAction(null);
      else showActionError(err, t);
    } finally {
      setLoading(false);
    }
  };

  const handleGuardianOtpSubmit = async (otp: string) => {
    if (!guardianChallenge) return;
    const { type, schema, formData, targetItemId } = guardianChallenge;
    await onActionSubmit?.(type, schema, formData, targetItemId, otp);
    setGuardianChallenge(null);
    toast.success(t('actions.handler_completed_title'), {
      description: t('actions.handler_completed_desc'),
    });
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
      />
    </>
  );
}
