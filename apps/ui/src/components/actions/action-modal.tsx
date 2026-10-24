import * as React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema } from '@/engine/types';
import { useIsMobile } from '@/hooks/use-mobile';
import { SchemaForm } from '@/components/forms/schema-form';
import { resolveRefs } from '@/engine/schema/resolve-schema';
import { ActionModalHeader } from './action-modal-header';
import { ConsentCheckbox } from './consent-checkbox';
import { getActionDisplay } from '@/lib/action-display';
import { ACTION_CONSENT_SENTINEL } from '@/lib/action-api';
import { renderConsentStatement } from '@/lib/consent-copy';
import { cn } from '@/lib/utils';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { useNetworkTheme } from '@/theme/theme-provider';

import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

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
  /**
   * Minor ward on a guardian-gated domain: ticking the consent submits, so
   * ActionHandler's guardian confirm and OTP flow starts without a separate
   * Confirm.
   */
  minor?: boolean;
}

const ACTION_FORM_ID = 'action-requirement-form';

// Subtitle i18n keys per known action; others use
// actions.modal_subtitle_fallback with the action title.
const ACTION_SUBTITLE_KEYS: Record<string, string> = {
  connect: 'actions.modal_subtitle_connect',
  accept: 'actions.modal_subtitle_accept',
  reject: 'actions.modal_subtitle_reject',
  cancel: 'actions.modal_subtitle_cancel',
  complete: 'actions.modal_subtitle_complete',
};

export function ActionModal({
  open,
  onOpenChange,
  actionSchema,
  onSubmit,
  loading = false,
  minor = false,
}: ActionModalProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [resolvedSchema, setResolvedSchema] = React.useState<RJSFSchema | null>(null);
  const { config } = useConsentConfig();
  const { brand } = useNetworkTheme();
  const actionType = actionSchema.action_type;
  const initDoc = config?.actions?.[actionType]?.initiate;
  const initVersion = initDoc?.versions.find((v) => v.version === initDoc.current_version);
  // Initiate stage: the actor shares details with the item they're connecting
  // to, so the counterparty noun is the target domain.
  const consentText = renderConsentStatement(
    initVersion?.statement ?? '',
    actionSchema.to_domain,
  );
  const consentRequired = (actionSchema.reveals_pii_on_status?.length ?? 0) > 0;
  const [consentChecked, setConsentChecked] = useState(false);

  React.useEffect(() => {
    if (!open) return;

    setConsentChecked(false);

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

  const handleSubmit = (formData: Record<string, unknown>) => {
    const payload: Record<string, unknown> = { ...formData };
    // Submit is only reachable once consent is ticked (Confirm is gated on it;
    // for minors the tick submits), so do not read the possibly stale
    // `consentChecked`.
    if (consentRequired) {
      payload[ACTION_CONSENT_SENTINEL] = {
        acknowledged: true as const,
        version: initDoc?.current_version ?? 1,
        brand: brand === 'standard' ? null : brand,
      };
    }
    onSubmit(payload);
  };

  // Minor: the consent tick submits, via the form's native submit when there
  // is a form so validation runs.
  const handleMinorConsentTick = () => {
    const formEl = document.getElementById(ACTION_FORM_ID) as HTMLFormElement | null;
    if (resolvedSchema && formEl) formEl.requestSubmit();
    else handleSubmit({});
  };

  const formContent = (
    <>
      {resolvedSchema ? (
        <SchemaForm
          id={ACTION_FORM_ID}
          schema={resolvedSchema}
          hideSubmit
          onSubmit={handleSubmit}
        />
      ) : (
        <p className="text-muted-foreground text-sm">{t('actions.modal_no_form')}</p>
      )}
      {consentRequired && (
        <ConsentCheckbox
          text={consentText}
          checked={consentChecked}
          onCheckedChange={(v) => {
            setConsentChecked(v);
            if (v && minor) handleMinorConsentTick();
          }}
        />
      )}
    </>
  );

  const consentGate = consentRequired && !consentChecked;

  const confirmButtonProps = resolvedSchema
    ? { type: 'submit' as const, form: ACTION_FORM_ID }
    : { type: 'button' as const, onClick: () => handleSubmit({}) };

  const actionKey = actionSchema.action_type ?? 'connect';
  const display = getActionDisplay(actionKey);
  const actionTitle = display.label;
  // The consent card frames the action, so the generic subtitle is dropped.
  const subtitleKey = ACTION_SUBTITLE_KEYS[actionKey.toLowerCase()];
  const subtitle = consentRequired
    ? undefined
    : subtitleKey
      ? t(subtitleKey)
      : t('actions.modal_subtitle_fallback', { actionTitle });

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
        {t('common.cancel')}
      </Button>
      <Button
        {...confirmButtonProps}
        disabled={loading || consentGate}
        className={cn('min-w-[120px] font-semibold shadow-sm', display.buttonClass)}
      >
        {loading ? t('actions.modal_processing') : t('actions.modal_confirm')}
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90dvh] overflow-hidden p-0">
          <div className="px-6 pt-6">{header}</div>
          <div className="px-6 pb-4 overflow-y-auto">{formContent}</div>
          <div className="border-t px-6 py-4">{footer}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed header and footer with a scrolling body, so a long consent
          statement does not push Cancel/Confirm off screen. */}
      <DialogContent className="sm:max-w-[520px] max-h-[90dvh] overflow-hidden gap-0 p-0 flex flex-col">
        <div className="px-6 pt-6">{header}</div>
        <div className="px-6 py-4 overflow-y-auto">{formContent}</div>
        <div className="px-6 pb-6">{footer}</div>
      </DialogContent>
    </Dialog>
  );
}
