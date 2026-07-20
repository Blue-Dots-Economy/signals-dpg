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
import { getActionContactDetails } from '@/lib/action-api';
import { fetchNetworkItems } from '@/lib/network-api';

/** The counterparty of an action (the other party's item), resolved by the card. */
export interface ProfileCardCounterparty {
  name: string;
  itemId: string;
  itemNetwork: string;
  itemDomain: string;
  itemType: string;
}

interface ProfileCardModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionId: string;
  actionStatus: string;
  counterparty: ProfileCardCounterparty;
}

// Server error codes → i18n keys, resolved via t() so the user sees translated
// copy rather than raw English server text. Shared with the (now-folded-in)
// contact-reveal path.
const errorMessageKeys: Record<string, string> = {
  PII_NOT_REVEALED: 'contact.error_pii_not_revealed',
  CROSS_INSTANCE_REVEAL_NOT_SUPPORTED: 'contact.error_cross_instance',
  NOT_ACTION_PARTICIPANT: 'contact.error_not_participant',
  UNAUTHORIZED: 'contact.error_unauthorized',
  ACTION_NOT_FOUND: 'contact.error_action_not_found',
  OTHER_ITEM_NOT_FOUND: 'contact.error_other_item_not_found',
  INTERNAL_SERVER_ERROR: 'contact.error_internal',
};

/**
 * PII is revealed by the server only once a request is accepted, and stays
 * revealed through completion. For those statuses we fetch the UNMASKED profile
 * via the consent-gated contact endpoint; for every other status we fetch the
 * counterparty's PUBLIC (masked) profile via the network fetch, which never
 * returns PII. This mirrors the server's `reveals_pii_on_status` gate.
 */
function statusRevealsPii(status: string): boolean {
  return status === 'accepted' || status === 'completed';
}

/** Minimal shape both fetch paths normalise to for rendering. */
interface ResolvedItem {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
}

type ModalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; item: ResolvedItem; masked: boolean }
  | { status: 'error'; message: string };

/**
 * Shows the profile of an action's counterparty as a `DomainCard`. Unmasked
 * (incl. contact details) once the request reveals PII (accepted/completed),
 * masked (public fields only) otherwise. Works for both initiated and received
 * actions — the caller passes the resolved counterparty.
 */
export function ProfileCardModal({
  open,
  onOpenChange,
  actionId,
  actionStatus,
  counterparty,
}: ProfileCardModalProps) {
  const { t } = useTranslation();
  const [state, setState] = React.useState<ModalState>({ status: 'idle' });

  const { name, itemId, itemNetwork, itemDomain, itemType } = counterparty;
  const wantsUnmasked = statusRevealsPii(actionStatus);

  React.useEffect(() => {
    if (!open) {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    const fetchMasked = async (): Promise<ResolvedItem> => {
      const res = await fetchNetworkItems({
        item_network: itemNetwork,
        item_domain: itemDomain,
        item_type: itemType,
        item_id: itemId,
        limit: 1,
      });
      const item = res.items?.[0];
      if (!item) {
        throw Object.assign(new Error('profile not found'), {
          code: 'OTHER_ITEM_NOT_FOUND',
        });
      }
      return {
        item_network: item.item_network,
        item_domain: item.item_domain,
        item_type: item.item_type,
        item_state: item.item_state,
      };
    };

    async function run() {
      try {
        let item: ResolvedItem;
        let masked: boolean;
        if (wantsUnmasked) {
          try {
            const data = await getActionContactDetails(actionId);
            const it = data.other_actor.item;
            item = {
              item_network: it.item_network,
              item_domain: it.item_domain,
              item_type: it.item_type,
              item_state: it.item_state,
            };
            masked = false;
          } catch {
            // Reveal unavailable (e.g. cross-instance reveal not supported) —
            // fall back to the public profile rather than showing an error.
            item = await fetchMasked();
            masked = true;
          }
        } else {
          item = await fetchMasked();
          masked = true;
        }
        if (!cancelled) setState({ status: 'success', item, masked });
      } catch (err) {
        if (cancelled) return;
        const code = (err as { code?: string }).code ?? 'INTERNAL_SERVER_ERROR';
        const key = errorMessageKeys[code];
        setState({
          status: 'error',
          message: key ? t(key) : (err as Error).message,
        });
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [open, actionId, wantsUnmasked, itemId, itemNetwork, itemDomain, itemType, t]);

  const item = state.status === 'success' ? state.item : null;
  const { data: networkConfig } = useNetworkConfig(item?.item_network ?? null);
  const schema = React.useMemo<RJSFSchema | null>(() => {
    if (!item || !networkConfig) return null;
    const domain = networkConfig.domains.find((d) => d.id === item.item_domain);
    return (domain?.item_schemas?.[item.item_type] as RJSFSchema | undefined) ?? null;
  }, [item, networkConfig]);

  // Before the fetch settles, key the description off the expected mode so the
  // copy doesn't flash the wrong line for accepted requests.
  const showFull = state.status === 'success' ? !state.masked : wantsUnmasked;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>
            {showFull ? t('profile.card_desc_full') : t('profile.card_desc_masked')}
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
          <DomainCard schema={schema} schemaName={item.item_domain} data={item.item_state} />
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
