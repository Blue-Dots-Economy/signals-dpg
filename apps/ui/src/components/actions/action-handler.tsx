import * as React from 'react';
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
      toast.success(`${type} completed`, {
        description: 'Your request was submitted successfully.',
      });
    } catch (err) {
      toast.error(`Couldn't complete ${type}`, {
        description: 'Something went wrong while processing your request. Please try again.',
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
      toast.success(`${activeAction.type} completed`, {
        description: 'Your request was submitted successfully.',
      });
      setActiveAction(null);
    } catch (err) {
      toast.error(`Couldn't complete ${activeAction.type}`, {
        description: 'Something went wrong while processing your request. Please try again.',
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
