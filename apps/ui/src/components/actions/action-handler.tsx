import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { DotActionSchema } from '@/engine/types';
import { ActionModal } from './action-modal';
import { toast } from 'sonner';

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
      toast.error(t('actions.handler_error_title'), {
        description: t('actions.handler_error_desc'),
      });
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
      toast.error(t('actions.handler_error_title'), {
        description: t('actions.handler_error_desc'),
      });
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
