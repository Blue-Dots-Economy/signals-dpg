import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useInitiatedActions, useReceivedActions } from '@/hooks/use-actions';
import { useCardSelection } from '@/hooks/use-card-selection';
import { ActionList } from '@/components/actions/action-list';
import { ActionStatusUpdater } from '@/components/actions/action-status-updater';
import { BulkStatusDialog } from '@/components/actions/bulk-status-dialog';
import { Button } from '@/components/ui/button';
import type { Action } from '@/lib/action-api';

type TabValue = 'initiated' | 'received';

export function MyActionsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = React.useState<TabValue>('received');
  const [selectedAction, setSelectedAction] = React.useState<Action | null>(null);
  const [isStatusModalOpen, setIsStatusModalOpen] = React.useState(false);
  const [suggestedStatus, setSuggestedStatus] = React.useState<string>('');
  const selection = useCardSelection();
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkStatus, setBulkStatus] = React.useState<string>('');

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

  const handleTabChange = (tab: TabValue) => {
    selection.exitSelect();
    setActiveTab(tab);
  };

  const handleStatusUpdate = (action: Action, targetStatus: string) => {
    setSelectedAction(action);
    setSuggestedStatus(targetStatus);
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

  const sourceActions = activeTab === 'initiated' ? initiatedActions : receivedActions;
  const selectedActions = sourceActions.filter((a) => selection.selected.has(a.action_id));

  return (
    <div className="min-h-svh bg-background">
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
        <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-xl"
              onClick={() => navigate(-1)}
              aria-label={t('actions.my_actions_back')}
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-2xl font-extrabold leading-tight tracking-tight text-foreground">
                {t('actions.my_actions_title')}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t('actions.my_actions_subtitle')}
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <ActionList
          initiatedActions={initiatedActions}
          receivedActions={receivedActions}
          isLoading={isLoading}
          isError={isError}
          error={error}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onStatusUpdate={(action, targetStatus) => handleStatusUpdate(action, targetStatus)}
          onRefresh={handleRefresh}
          isRefetching={isRefetching}
          selection={selection}
          onBulkAction={(targetStatus) => {
            setBulkStatus(targetStatus);
            setBulkOpen(true);
          }}
        />
      </main>

      <ActionStatusUpdater
        action={selectedAction}
        open={isStatusModalOpen}
        onOpenChange={setIsStatusModalOpen}
        suggestedStatus={suggestedStatus}
      />
      <BulkStatusDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        actions={selectedActions}
        targetStatus={bulkStatus}
        onSettled={(_succeeded, _total, failedIds) => {
          if (failedIds.length === 0) selection.exitSelect();
          else selection.setSelected(failedIds);
        }}
      />
    </div>
  );
}
