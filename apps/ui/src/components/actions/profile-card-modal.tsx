import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig } from '@/engine/types';
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
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

// Server error codes to i18n keys, so the user never sees raw server text.
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
 * Guesses whether this status reveals PII, only to pick the description shown
 * before the fetch settles. Hardcodes the default gate (accepted, completed)
 * rather than the interaction's `reveals_pii_on_status`; the server decides
 * the actual reveal.
 */
function statusRevealsPii(status: string): boolean {
  return status === 'accepted' || status === 'completed';
}

// Reveal-endpoint codes that mean the reveal is legitimately unavailable, not
// a failure: the public profile is shown instead. Any other code surfaces as
// an error rather than masked copy that contradicts an accepted request.
const REVEAL_UNAVAILABLE_CODES = new Set([
  'CROSS_INSTANCE_REVEAL_NOT_SUPPORTED',
  'PII_NOT_REVEALED',
]);

/** Minimal shape both fetch paths normalise to for rendering. */
interface ResolvedItem {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
}

// masked: public profile, request not revealing; full: reveal succeeded;
// reveal_unavailable: public profile, the other party is not live;
// reveal_blocked_self: public profile, the viewer's own profile is not live;
// reveal_retired: the counterparty permanently removed their profile.
type ViewMode = 'masked' | 'full' | 'reveal_unavailable' | 'reveal_blocked_self' | 'reveal_retired';

type ModalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; item: ResolvedItem; mode: ViewMode }
  | { status: 'error'; message: string };

/**
 * Shows an action's counterparty as a `DomainCard`: unmasked (with contact
 * details) when the server reveals PII, public fields otherwise.
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

    const resolve = async (): Promise<{ item: ResolvedItem; mode: ViewMode }> => {
      // Contact-details first: it is the only source that can resolve a
      // paused or retired counterparty (the item fetch is live-only). It
      // reveals PII when allowed, else returns the masked view and a
      // reveal_blocked_reason.
      try {
        const data = await getActionContactDetails(actionId);
        const it = data.other_actor.item;
        return {
          item: {
            item_network: it.item_network,
            item_domain: it.item_domain,
            item_type: it.item_type,
            item_state: it.item_state,
          },
          mode: data.revealed
            ? 'full'
            : data.reveal_blocked_reason === 'self'
              ? 'reveal_blocked_self'
              : data.reveal_blocked_reason === 'retired'
                ? 'reveal_retired'
                : 'reveal_unavailable',
        };
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'INTERNAL_SERVER_ERROR';
        // Not at a revealing status and the counterparty is live.
        if (code === 'PII_NOT_REVEALED') {
          return { item: await fetchMasked(), mode: 'masked' };
        }
        if (REVEAL_UNAVAILABLE_CODES.has(code)) {
          return { item: await fetchMasked(), mode: 'reveal_unavailable' };
        }
        throw err;
      }
    };

    async function run() {
      try {
        const resolved = await resolve();
        if (!cancelled) setState({ status: 'success', ...resolved });
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

  // Per-domain card config, so the card uses the network's title and fields.
  const cardConfig = React.useMemo<DotCardConfig | null>(() => {
    if (!item || !networkConfig) return null;
    const domain = networkConfig.domains.find((d) => d.id === item.item_domain);
    return (domain?.card as DotCardConfig | undefined) ?? null;
  }, [item, networkConfig]);

  // Before the fetch settles, guess from the status so the copy does not
  // flash the wrong line.
  const descKey =
    state.status === 'success'
      ? state.mode === 'full'
        ? 'profile.card_desc_full'
        : state.mode === 'reveal_retired'
          ? 'profile.card_desc_reveal_retired'
          : state.mode === 'reveal_blocked_self'
            ? 'profile.card_desc_reveal_blocked_self'
            : state.mode === 'reveal_unavailable'
              ? 'profile.card_desc_reveal_unavailable'
              : 'profile.card_desc_masked'
      : wantsUnmasked
        ? 'profile.card_desc_full'
        : 'profile.card_desc_masked';

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={name} contentClassName="max-w-xl">
      {/* A block, not a flex column: `DomainCard`'s root has
          `overflow-hidden`, so as a flex item its minimum size is 0 and it
          would shrink and clip itself instead of this region scrolling.
          `ResponsiveDialog` bounds the height (90dvh dialog, 80dvh drawer). */}
      <div className="space-y-4 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{t(descKey)}</DialogDescription>
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

        {/* A retired profile shows only the notice; its leftover fields must
            not render as a card. */}
        {state.status === 'success' && state.mode !== 'reveal_retired' && item && schema && (
          <DomainCard schema={schema} cardConfig={cardConfig} schemaName={item.item_domain} data={item.item_state} />
        )}

        {state.status === 'success' && state.mode !== 'reveal_retired' && item && !schema && (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(item.item_state, null, 2)}
          </pre>
        )}
      </div>
    </ResponsiveDialog>
  );
}
