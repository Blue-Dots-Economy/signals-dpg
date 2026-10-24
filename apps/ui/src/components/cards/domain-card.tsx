import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema, DotCardConfig } from '@/engine/types';
import { Skeleton } from '@/components/ui/skeleton';
import { ItemCard } from './item-card';
import { ActionButton } from './action-button';
import { MatchScoreButton } from '@/components/match-score';
import { resolveCardMetric } from '@/lib/metric-display';
import { isFreeTextMatchScoreEnabled } from '@/lib/match-score-config';
import type { BrowseSort } from '@/lib/browse-discover';
import { ShareProfileButton } from '@/components/share/share-profile-button';
import type { Item } from '@/lib/item-api';
import type { MatchScoreResult } from '@/lib/match-score-api';

interface DomainCardProps {
  schema: RJSFSchema;
  schemaName?: string;
  schemaDescription?: string;
  domainLabel?: string;
  /** Per-domain card config from network.json (drives default fields). */
  cardConfig?: DotCardConfig | null;
  data: Record<string, unknown>;
  actions?: DotActionSchema[];
  onAction?: (type: string, schema: DotActionSchema) => void;
  loading?: boolean;
  onClick?: () => void;
  // Match score props
  localItem?: Item | null;
  networkItem?: Item;
  matchScore?: MatchScoreResult | null;
  /**
   * The sort the server applied, which decides whether the pill shows a
   * relevance %, a distance or an age. Undefined outside the browse list,
   * where the pill falls back to the profile relevance score.
   */
  sortApplied?: BrowseSort;
  /** Which quantity `relevance` means; only used for the pill tooltip. */
  relevanceBasis?: 'profile' | 'search' | null;
  matchScoreLoading?: boolean;
  matchScoreError?: Error | null;
  onCalculateMatch?: () => void;
  onViewMatchDetails?: () => void;
  /** When true, hide the action/match footer (the card is a selection target). */
  selectionMode?: boolean;
  /** When live, shows a Share button in the card header. Full item (for its key). */
  shareItem?: Item | null;
  /** Disable the action CTAs: an open action already exists for this pair. */
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
}

export function DomainCard({
  schema,
  domainLabel,
  cardConfig,
  data,
  actions = [],
  onAction,
  loading = false,
  onClick,
  localItem,
  networkItem,
  matchScore,
  sortApplied,
  relevanceBasis,
  matchScoreLoading,
  matchScoreError,
  onCalculateMatch,
  onViewMatchDetails,
  selectionMode = false,
  shareItem,
  actionsDisabled = false,
  actionsDisabledReason,
}: Readonly<DomainCardProps>) {
  if (loading) {
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-background shadow-sm">
        <div className="flex items-center gap-3 bg-muted px-4 py-3">
          <Skeleton className="h-11 w-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <div className="space-y-3 px-4 py-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    );
  }

  // The card's ranking basis; decides which pill renders and whether one can.
  const cardMetric = sortApplied
    ? resolveCardMetric({
        sortApplied,
        score: matchScore?.score ?? networkItem?.score ?? null,
        distanceMeters: networkItem?.distanceMeters ?? null,
        createdAt: networkItem?.created_at ? new Date(networkItem.created_at) : null,
        freeTextScoreEnabled: isFreeTextMatchScoreEnabled(),
        hasProfile: !!localItem,
      })
    : undefined;

  // A distance or age is not a match score, so it shows without
  // `onCalculateMatch` (which only viewers with a profile get). Relevance
  // still needs it.
  const metricOnly = cardMetric != null && cardMetric.kind !== 'relevance';
  const showMatch = !!networkItem && (!!onCalculateMatch || metricOnly);
  const showActions = actions.length > 0 && !!onAction;
  const footer =
    !selectionMode && (showActions || showMatch) ? (
      <>
        {showMatch && (
          <MatchScoreButton
            // Pass a metric only inside a sorted list. Omitting the prop lets
            // MatchScoreButton fall back to the profile relevance score; an
            // explicit `null` would suppress the pill.
            {...(sortApplied ? { metric: cardMetric } : {})}
            basis={relevanceBasis ?? null}
            localItem={localItem ?? null}
            networkItem={networkItem as Item}
            score={matchScore ?? null}
            isLoading={matchScoreLoading ?? false}
            error={matchScoreError ?? null}
            onCalculate={onCalculateMatch ?? (() => {})}
            onViewDetails={onViewMatchDetails}
            disabled={!localItem}
          />
        )}
        {actions.map((action) => (
          <ActionButton
            key={action.action_type}
            actionType={action.action_type}
            actionSchema={action}
            disabled={actionsDisabled}
            disabledReason={actionsDisabledReason}
            onAction={(type, actionSchema) => {
              onAction?.(type, actionSchema);
            }}
          />
        ))}
      </>
    ) : undefined;

  return (
    <ItemCard
      variant="list"
      schema={schema}
      cardConfig={cardConfig}
      data={data}
      domainLabel={domainLabel}
      // In select mode the SelectableCard wrapper owns the interaction, so the
      // card must not add a focusable control inside its `role="button"`.
      onClick={selectionMode ? undefined : onClick}
      actions={footer}
      headerAction={
        <ShareProfileButton
          item={shareItem}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white hover:bg-white/25"
        />
      }
    />
  );
}
