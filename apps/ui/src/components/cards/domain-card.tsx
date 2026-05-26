import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema, PrivacyMode } from '@/engine/types';
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
  /** Controls whether `private: true` fields are rendered. Defaults to `'public-only'`. */
  privacyMode?: PrivacyMode;
}

export function DomainCard({
  schema,
  schemaName,
  schemaDescription,
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
  privacyMode = 'public-only',
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
      className="h-full flex flex-col transition-shadow"
      onClick={onClick}
    >
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        {schemaDescription && (
          <CardDescription>{schemaDescription}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        <CardFieldsFromSchema schema={schema} data={data} privacyMode={privacyMode} />
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
