import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { DomainCard } from '@/components/cards/domain-card';
import { useNetworkConfig } from '@/hooks/use-network-config';
import {
  getActionContactDetails,
  type ContactDetailsResponse,
} from '@/lib/action-api';

interface ContactDetailsModalProps {
  actionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Map server error codes → i18n keys. The component resolves them via t() so
// the user sees translated copy in their locale instead of English server text.
const errorMessageKeys: Record<string, string> = {
  PII_NOT_REVEALED: 'contact.error_pii_not_revealed',
  CROSS_INSTANCE_REVEAL_NOT_SUPPORTED: 'contact.error_cross_instance',
  NOT_ACTION_PARTICIPANT: 'contact.error_not_participant',
  UNAUTHORIZED: 'contact.error_unauthorized',
  ACTION_NOT_FOUND: 'contact.error_action_not_found',
  OTHER_ITEM_NOT_FOUND: 'contact.error_other_item_not_found',
  INTERNAL_SERVER_ERROR: 'contact.error_internal',
};

type ModalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ContactDetailsResponse }
  | { status: 'error'; code: string; message: string };

export function ContactDetailsModal({
  actionId,
  open,
  onOpenChange,
}: ContactDetailsModalProps) {
  const { t } = useTranslation();
  const [state, setState] = React.useState<ModalState>({ status: 'idle' });

  React.useEffect(() => {
    if (!open) {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    getActionContactDetails(actionId)
      .then((data) => {
        if (!cancelled) setState({ status: 'success', data });
      })
      .catch((err: Error & { code?: string }) => {
        if (cancelled) return;
        const code = err.code ?? 'INTERNAL_SERVER_ERROR';
        const messageKey = errorMessageKeys[code];
        setState({
          status: 'error',
          code,
          message: messageKey ? t(messageKey) : err.message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [open, actionId, t]);

  const item = state.status === 'success' ? state.data.other_actor.item : null;
  const { data: networkConfig } = useNetworkConfig(item?.item_network ?? null);
  const schema = React.useMemo<RJSFSchema | null>(() => {
    if (!item || !networkConfig) return null;
    const domain = networkConfig.domains.find((d) => d.id === item.item_domain);
    const raw = domain?.item_schemas?.[item.item_type];
    return (raw as RJSFSchema | undefined) ?? null;
  }, [item, networkConfig]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('contact.dialog_title')}</DialogTitle>
          <DialogDescription>
            {t('contact.dialog_desc')}
          </DialogDescription>
        </DialogHeader>

        {state.status === 'loading' && (
          <p className="text-sm text-muted-foreground">{t('contact.loading')}</p>
        )}

        {state.status === 'error' && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm font-semibold text-destructive">
              {t('contact.error_title')}
            </p>
            <p className="mt-1 text-sm text-destructive/80">{state.message}</p>
          </div>
        )}

        {state.status === 'success' && item && schema && (
          <DomainCard
            schema={schema}
            schemaName={item.item_domain}
            data={item.item_state}
          />
        )}

        {state.status === 'success' && item && !schema && (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(item.item_state, null, 2)}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
