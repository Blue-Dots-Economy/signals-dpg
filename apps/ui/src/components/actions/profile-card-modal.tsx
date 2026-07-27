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
 * Whether to ATTEMPT the unmasked reveal for this status. The server is the
 * real gate (it reveals only when the action's own `reveals_pii_on_status`
 * includes the current status, else returns PII_NOT_REVEALED); this is a
 * client-side hint to avoid a doomed reveal call for obviously-not-revealed
 * statuses. Hardcoded to the default gate (accepted → stays revealed through
 * completion) rather than threading the per-interaction `reveals_pii_on_status`
 * array in here. A wrong guess degrades gracefully, not incorrectly:
 * - guess too NARROW (a network reveals on some other status): we show masked,
 *   never leaking PII;
 * - guess too WIDE (we try reveal on a status the server won't reveal): the
 *   server returns PII_NOT_REVEALED, which falls back to the masked profile
 *   with a "not available" note (see REVEAL_UNAVAILABLE_CODES below).
 * If a network ever customises `reveals_pii_on_status`, thread it in here.
 */
function statusRevealsPii(status: string): boolean {
  return status === 'accepted' || status === 'completed';
}

// Reveal-endpoint error codes that mean "the contact reveal is legitimately
// unavailable here" (not a failure). For these we show the public profile with
// a distinct note; every OTHER code (UNAUTHORIZED, NOT_ACTION_PARTICIPANT,
// ACTION_NOT_FOUND, INTERNAL_SERVER_ERROR, …) surfaces as an error rather than
// silently showing masked copy that contradicts an accepted request.
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

// masked → public profile, request not (yet) revealing; full → reveal succeeded;
// reveal_unavailable → public profile because the OTHER party isn't live;
// reveal_blocked_self → public profile because the VIEWER's own profile isn't live.
// reveal_retired → the counterparty permanently removed their profile (#347).
type ViewMode = 'masked' | 'full' | 'reveal_unavailable' | 'reveal_blocked_self' | 'reveal_retired';

type ModalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; item: ResolvedItem; mode: ViewMode }
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

    const resolve = async (): Promise<{ item: ResolvedItem; mode: ViewMode }> => {
      // Always ask the action's contact-details endpoint first — it's the only
      // source that can resolve a NON-live counterparty (paused #273, or retired
      // #347), which the network item fetch (live-only) can't see. It reveals
      // PII when allowed, else returns the masked view + a reveal_blocked_reason.
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
        // PII_NOT_REVEALED: the action simply isn't at a revealing status and the
        // counterparty is live — show the ordinary masked public profile.
        if (code === 'PII_NOT_REVEALED') {
          return { item: await fetchMasked(), mode: 'masked' };
        }
        // Other "reveal legitimately unavailable" codes → masked public + note.
        if (REVEAL_UNAVAILABLE_CODES.has(code)) {
          return { item: await fetchMasked(), mode: 'reveal_unavailable' };
        }
        // A real failure — surface it.
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

  // Description keyed off the resolved mode. Before the fetch settles, guess
  // from the expected mode so the copy doesn't flash the wrong line.
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
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

        {/* A retired profile shows only the notice (in the description) — its
            leftover non-PII fields must not be rendered as a card (#347). */}
        {state.status === 'success' && state.mode !== 'reveal_retired' && item && schema && (
          <DomainCard schema={schema} schemaName={item.item_domain} data={item.item_state} />
        )}

        {state.status === 'success' && state.mode !== 'reveal_retired' && item && !schema && (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(item.item_state, null, 2)}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
