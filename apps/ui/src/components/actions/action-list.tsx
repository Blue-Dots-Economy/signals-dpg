import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw, Inbox, Send, AlertCircle } from 'lucide-react';
import { ActionCard } from './action-card';
import type { Action } from '@/lib/action-api';

interface ActionListProps {
  initiatedActions: Action[];
  receivedActions: Action[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  activeTab: 'initiated' | 'received';
  onTabChange: (tab: 'initiated' | 'received') => void;
  onStatusUpdate: (action: Action) => void;
  onRefresh: () => void;
  isRefetching: boolean;
}

export function ActionList({
  initiatedActions,
  receivedActions,
  isLoading,
  isError,
  error,
  activeTab,
  onTabChange,
  onStatusUpdate,
  onRefresh,
  isRefetching,
}: ActionListProps) {
  const handleTabChange = (value: string) => {
    onTabChange(value as 'initiated' | 'received');
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight">My Actions</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefetching}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="initiated" className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            <span>Initiated</span>
            {initiatedActions.length > 0 && (
              <span className="ml-1 text-xs bg-muted rounded-full px-2 py-0.5">
                {initiatedActions.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="received" className="flex items-center gap-2">
            <Inbox className="h-4 w-4" />
            <span>Received</span>
            {receivedActions.length > 0 && (
              <span className="ml-1 text-xs bg-primary/10 text-primary rounded-full px-2 py-0.5 font-medium">
                {receivedActions.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="initiated" className="mt-4">
          <ActionListContent
            actions={initiatedActions}
            ownershipRole="initiated"
            isLoading={isLoading}
            isError={isError}
            error={error}
            onStatusUpdate={onStatusUpdate}
            emptyMessage="You haven't initiated any actions yet."
            emptySubMessage="Browse items and use action buttons to connect with others."
          />
        </TabsContent>

        <TabsContent value="received" className="mt-4">
          <ActionListContent
            actions={receivedActions}
            ownershipRole="received"
            isLoading={isLoading}
            isError={isError}
            error={error}
            onStatusUpdate={onStatusUpdate}
            emptyMessage="No actions received yet."
            emptySubMessage="When someone initiates an action with your items, they will appear here."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface ActionListContentProps {
  actions: Action[];
  ownershipRole: 'initiated' | 'received';
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onStatusUpdate: (action: Action) => void;
  emptyMessage: string;
  emptySubMessage: string;
}

function ActionListContent({
  actions,
  ownershipRole,
  isLoading,
  isError,
  error,
  onStatusUpdate,
  emptyMessage,
  emptySubMessage,
}: ActionListContentProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <ActionCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h3 className="text-lg font-semibold text-destructive">Failed to load actions</h3>
        <p className="text-muted-foreground text-sm mt-2 max-w-md">
          {error?.message ?? 'An unexpected error occurred while fetching your actions.'}
        </p>
      </div>
    );
  }

  if (actions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center border rounded-lg bg-muted/50">
        <Inbox className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold">{emptyMessage}</h3>
        <p className="text-muted-foreground text-sm mt-2 max-w-md">{emptySubMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {actions.map((action) => (
        <ActionCard
          key={action.action_id}
          action={action}
          ownershipRole={ownershipRole}
          onStatusUpdate={onStatusUpdate}
        />
      ))}
    </div>
  );
}

function ActionCardSkeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <div className="flex items-center gap-2 pt-2">
        <Skeleton className="h-10 flex-1" />
        <Skeleton className="h-10 flex-1" />
      </div>
    </div>
  );
}
