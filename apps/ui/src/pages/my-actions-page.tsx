import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useInitiatedActions, useReceivedActions } from '@/hooks/use-actions';
import { ActionList } from '@/components/actions/action-list';
import { ActionStatusUpdater } from '@/components/actions/action-status-updater';
import { Button } from '@/components/ui/button';
import type { Action } from '@/lib/action-api';

type TabValue = 'initiated' | 'received';

export function MyActionsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = React.useState<TabValue>('received');
  const [selectedAction, setSelectedAction] = React.useState<Action | null>(null);
  const [isStatusModalOpen, setIsStatusModalOpen] = React.useState(false);
  const [suggestedStatus, setSuggestedStatus] = React.useState<string>('');

  // Fetch initiated actions with auto-polling (every 5s)
  const {
    data: initiatedData,
    isLoading: isInitiatedLoading,
    isError: isInitiatedError,
    error: initiatedError,
    refetch: refetchInitiated,
    isRefetching: isInitiatedRefetching,
  } = useInitiatedActions();

  // Fetch received actions with auto-polling (every 5s)
  const {
    data: receivedData,
    isLoading: isReceivedLoading,
    isError: isReceivedError,
    error: receivedError,
    refetch: refetchReceived,
    isRefetching: isReceivedRefetching,
  } = useReceivedActions();

  const handleStatusUpdate = (action: Action, suggestedNewStatus?: string) => {
    setSelectedAction(action);
    setSuggestedStatus(suggestedNewStatus ?? '');
    setIsStatusModalOpen(true);
  };

  const handleRefresh = () => {
    if (activeTab === 'initiated') {
      refetchInitiated();
    } else {
      refetchReceived();
    }
  };

  const isLoading = activeTab === 'initiated' ? isInitiatedLoading : isReceivedLoading;
  const isError = activeTab === 'initiated' ? isInitiatedError : isReceivedError;
  const error = activeTab === 'initiated' ? initiatedError : receivedError;
  const isRefetching = activeTab === 'initiated' ? isInitiatedRefetching : isReceivedRefetching;

  const initiatedActions = initiatedData?.actions ?? [];
  const receivedActions = receivedData?.actions ?? [];

  return (
    <div className="min-h-screen bg-background">
      {/* Header — brand chip + soft aura + page lockup */}
      <header className="relative overflow-hidden border-b bg-card">
        {/* Soft brand aura */}
        <div
          className="pointer-events-none absolute -right-24 -top-32 h-96 w-96 opacity-60"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklch, var(--primary) 22%, transparent), transparent 65%)',
          }}
        />
        <div className="relative mx-auto max-w-6xl px-6 py-6">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-xl"
              onClick={() => navigate(-1)}
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-2xl font-extrabold leading-tight tracking-tight text-foreground">
                My Actions
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Manage requests you&apos;ve initiated and the ones you&apos;ve received.
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        <ActionList
          initiatedActions={initiatedActions}
          receivedActions={receivedActions}
          isLoading={isLoading}
          isError={isError}
          error={error}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onStatusUpdate={(action) => handleStatusUpdate(action)}
          onRefresh={handleRefresh}
          isRefetching={isRefetching}
        />
      </main>

      <ActionStatusUpdater
        action={selectedAction}
        open={isStatusModalOpen}
        onOpenChange={setIsStatusModalOpen}
        suggestedStatus={suggestedStatus}
      />
    </div>
  );
}
