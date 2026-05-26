import * as React from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema } from '@/engine/types';
import { useIsMobile } from '@/hooks/use-mobile';
import { SchemaForm } from '@/components/forms/schema-form';
import { resolveRefs } from '@/engine/schema/resolve-schema';
import { ActionModalHeader } from './action-modal-header';
import { getActionDisplay } from '@/lib/action-display';
import { cn } from '@/lib/utils';

// Desktop: Dialog
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// Mobile: Drawer
import {
  Drawer,
  DrawerContent,
} from '@/components/ui/drawer';

interface ActionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionSchema: DotActionSchema;
  onSubmit: (formData: Record<string, unknown>) => void;
  loading?: boolean;
}

const ACTION_FORM_ID = 'action-requirement-form';

// Friendly subtitles per action — used in the colored header band below the title.
const ACTION_SUBTITLES: Record<string, string> = {
  connect: 'Share details so the other party can review your request.',
  accept: 'Confirm you want to accept this request.',
  reject: 'Let the other party know why this request is being declined.',
  cancel: 'Withdraw this request — both parties will be notified.',
  complete: 'Mark this as complete once everything is finished.',
};

export function ActionModal({
  open,
  onOpenChange,
  actionSchema,
  onSubmit,
  loading = false,
}: ActionModalProps) {
  const isMobile = useIsMobile();
  const [resolvedSchema, setResolvedSchema] = React.useState<RJSFSchema | null>(null);

  React.useEffect(() => {
    if (!open) return;

    const reqSchema = actionSchema.requirement_schema;
    if (!reqSchema) {
      setResolvedSchema(null);
      return;
    }

    if ('$ref' in reqSchema && typeof reqSchema.$ref === 'string') {
      resolveRefs(reqSchema as RJSFSchema)
        .then(setResolvedSchema)
        .catch(() => setResolvedSchema(null));
    } else {
      setResolvedSchema(reqSchema as RJSFSchema);
    }
  }, [open, actionSchema]);

  const formContent = resolvedSchema ? (
    <SchemaForm
      id={ACTION_FORM_ID}
      schema={resolvedSchema}
      hideSubmit
      onSubmit={onSubmit}
    />
  ) : (
    <p className="text-muted-foreground text-sm">No additional information required.</p>
  );

  const confirmButtonProps = resolvedSchema
    ? { type: 'submit' as const, form: ACTION_FORM_ID }
    : { type: 'button' as const, onClick: () => onSubmit({}) };

  const actionKey = actionSchema.action_type ?? 'connect';
  const display = getActionDisplay(actionKey);
  const actionTitle = display.label;
  const subtitle = ACTION_SUBTITLES[actionKey.toLowerCase()] ?? `${actionTitle} request`;

  const header = (
    <ActionModalHeader
      actionKey={actionKey}
      title={actionTitle}
      description={subtitle}
      fromDomain={actionSchema.from_domain}
      toDomain={actionSchema.to_domain}
    />
  );

  const footer = (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        variant="outline"
        onClick={() => onOpenChange(false)}
        disabled={loading}
      >
        Cancel
      </Button>
      <Button
        {...confirmButtonProps}
        disabled={loading}
        className={cn('min-w-[120px] rounded-full font-semibold shadow-sm', display.buttonClass)}
      >
        {loading ? `${actionTitle}ing...` : 'Confirm'}
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
