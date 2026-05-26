import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema } from '@/engine/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CardFieldsFromSchema } from './card-field';
import { ActionButton } from './action-button';
import { MatchScoreButton } from '@/components/match-score';
import type { Item } from '@/lib/item-api';
import type { MatchScoreResult } from '@/lib/match-score-api';

interface DomainCardProps {
  schema: RJSFSchema;
  schemaName?: string;
  schemaDescription?: string;
  domainLabel?: string;
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
}

export function DomainCard({
  schema,
  schemaName,
  schemaDescription,
  domainLabel,
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
}: DomainCardProps) {
  if (loading) {
    return (
      <Card className="h-full">
        <CardHeader>
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
    );
  }

  const titleKey = findTitleField(schema);
  const title = titleKey ? String(data[titleKey] ?? schemaName ?? 'Item') : schemaName ?? 'Item';

  return (
    <Card
      className="h-full flex flex-col relative overflow-hidden transition-all hover:shadow-md motion-safe:hover:-translate-y-0.5 before:absolute before:top-0 before:left-0 before:right-0 before:h-0.5 before:bg-primary/40"
      onClick={onClick}
    >
      <CardHeader>
        <div className="flex items-start gap-2">
          <CardTitle className="text-lg flex-1 min-w-0">{title}</CardTitle>
          {domainLabel && (
            <span className="shrink-0 rounded-full bg-primary/10 text-primary text-[11px] font-medium px-2 py-0.5 leading-none mt-0.5">
              {domainLabel}
            </span>
          )}
        </div>
        {schemaDescription && (
          <CardDescription>{schemaDescription}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        <CardFieldsFromSchema schema={schema} data={data} />
      </CardContent>
      {(actions.length > 0 && onAction) || (networkItem && onCalculateMatch) ? (
        <CardFooter className="flex flex-wrap gap-2">
          {networkItem && onCalculateMatch && (
            <MatchScoreButton
              localItem={localItem ?? null}
              networkItem={networkItem}
              score={matchScore ?? null}
              isLoading={matchScoreLoading ?? false}
              error={matchScoreError ?? null}
              onCalculate={onCalculateMatch}
              onViewDetails={onViewMatchDetails}
              disabled={!localItem}
            />
          )}
          {actions.map((action) => (
            <ActionButton
              key={action.action_type}
              actionType={action.action_type}
              actionSchema={action}
              onAction={(type, schema) => {
                onAction?.(type, schema);
              }}
            />
          ))}
        </CardFooter>
      ) : null}
    </Card>
  );
}

function findTitleField(schema: RJSFSchema): string | null {
  if (!schema.properties) return null;
  const candidates = ['name', 'full_name', 'title', 'provider_id', 'learner_id', 'student_id'];
  for (const key of candidates) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}
