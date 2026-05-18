import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema } from '@/engine/types';
import { DomainCard } from './domain-card';
import { MatchScoreCard } from '@/components/match-score';
import type { Item } from '@/lib/item-api';

interface CardGridProps {
  schema: RJSFSchema;
  schemaName?: string;
  schemaDescription?: string;
  items: Array<{ id: string; data: Record<string, unknown> }>;
  fullItems?: Item[];
  actions?: DotActionSchema[];
  onAction?: (itemId: string, type: string, schema: DotActionSchema) => void;
  onItemClick?: (itemId: string) => void;
  loading?: boolean;
  emptyMessage?: string;
  // Match score props
  localItem?: Item | null;
  networkId?: string;
  selectedDomain?: string | null;
}

export function CardGrid({
  schema,
  schemaName,
  schemaDescription,
  items,
  fullItems = [],
  actions = [],
  onAction,
  onItemClick,
  loading = false,
  emptyMessage = 'No items found',
  localItem,
  networkId = '',
  selectedDomain,
}: CardGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <DomainCard
            key={i}
            schema={schema}
            data={{}}
            loading
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        // Find the full Item object if available
        const fullItem = fullItems.find((i) => i.item_id === item.id);
        
        // Create a fallback item if full item not available
        const networkItem = fullItem || {
          item_id: item.id,
          item_network: networkId,
          item_domain: selectedDomain || '',
          item_type: 'profile',
          item_instance_url: null,
          item_schema_url: null,
          item_state: item.data,
          item_latitude: null,
          item_longitude: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        // If we have localItem and networkItem, use MatchScoreCard for match score support
        if (localItem && networkItem) {
          return (
            <MatchScoreCard
              key={item.id}
              schema={schema}
              schemaName={schemaName}
              schemaDescription={schemaDescription}
              data={item.data}
              actions={actions}
              onAction={(type, actionSchema) =>
                onAction?.(item.id, type, actionSchema)
              }
              onClick={() => onItemClick?.(item.id)}
              localItem={localItem}
              networkItem={networkItem}
            />
          );
        }

        // Fallback to regular DomainCard if no match score support needed
        return (
          <DomainCard
            key={item.id}
            schema={schema}
            schemaName={schemaName}
            schemaDescription={schemaDescription}
            data={item.data}
            actions={actions}
            onAction={(type, actionSchema) =>
              onAction?.(item.id, type, actionSchema)
            }
            onClick={() => onItemClick?.(item.id)}
          />
        );
      })}
    </div>
  );
}
