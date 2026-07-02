import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { DotActionSchema } from '@/engine/types';
import { ActionModal } from './action-modal';
import { ActionAbortedError } from '@/lib/action-abort';
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
    targetItemId: string
  ) => Promise<void> | void;
}

export function ActionHandler({ children, onActionSubmit }: ActionHandlerProps) {
  const { t } = useTranslation();
  const [activeAction, setActiveAction] = React.useState<{
    type: string;
    schema: DotActionSchema;
    targetItemId: string;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);

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

  const handleDirectSubmit = async (
    type: string,
    schema: DotActionSchema,
    targetItemId: string
  ) => {
    setLoading(true);
    try {
      await onActionSubmit?.(type, schema, {}, targetItemId);
      toast.success(t('actions.handler_completed_title'), {
        description: t('actions.handler_completed_desc'),
      });
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
      await onActionSubmit?.(activeAction.type, activeAction.schema, formData, activeAction.targetItemId);
      toast.success(t('actions.handler_completed_title'), {
        description: t('actions.handler_completed_desc'),
      });
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
    </>
  );
}
