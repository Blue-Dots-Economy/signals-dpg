import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema, DotCardConfig } from '@/engine/types';
import { Skeleton } from '@/components/ui/skeleton';
import { ItemCard } from './item-card';
import { ActionButton } from './action-button';
import { MatchScoreButton } from '@/components/match-score';
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
  matchScoreLoading?: boolean;
  matchScoreError?: Error | null;
  onCalculateMatch?: () => void;
  onViewMatchDetails?: () => void;
  /** When true, hide the action/match footer (the card is a selection target). */
  selectionMode?: boolean;
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
  matchScoreLoading,
  matchScoreError,
  onCalculateMatch,
  onViewMatchDetails,
  selectionMode = false,
}: DomainCardProps) {
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

  const showMatch = !!networkItem && !!onCalculateMatch;
  const showActions = actions.length > 0 && !!onAction;
  const footer =
    !selectionMode && (showActions || showMatch) ? (
      <>
        {showMatch && (
          <MatchScoreButton
            localItem={localItem ?? null}
            networkItem={networkItem as Item}
            score={matchScore ?? null}
            isLoading={matchScoreLoading ?? false}
            error={matchScoreError ?? null}
            onCalculate={onCalculateMatch as () => void}
            onViewDetails={onViewMatchDetails}
            disabled={!localItem}
          />
        )}
        {actions.map((action) => (
          <ActionButton
            key={action.action_type}
            actionType={action.action_type}
            actionSchema={action}
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
      onClick={onClick}
      actions={footer}
    />
  );
}
