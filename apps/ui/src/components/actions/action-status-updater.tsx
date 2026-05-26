import * as React from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Action } from '@/lib/action-api';
import { ActionModalHeader } from './action-modal-header';
import { getActionDisplay } from '@/lib/action-display';
import { cn } from '@/lib/utils';

// Desktop: Dialog
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

// Mobile: Drawer
import {
  Drawer,
  DrawerContent,
} from '@/components/ui/drawer';

import { useUpdateActionStatus } from '@/hooks/use-actions';
import { toast } from 'sonner';

interface ActionStatusUpdaterProps {
  action: Action | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestedStatus?: string;
}

const getValidTransitions = (currentStatus: string): string[] => {
  const transitions: Record<string, string[]> = {
    created: ['accepted', 'rejected', 'cancelled'],
    pending: ['accepted', 'rejected', 'cancelled'],
    accepted: ['completed', 'cancelled'],
    rejected: [],
    completed: [],
    cancelled: [],
  };
  return transitions[currentStatus] ?? [];
};

const statusLabels: Record<string, string> = {
  accepted: 'Accept',
  rejected: 'Reject',
  completed: 'Complete',
  cancelled: 'Cancel',
};

// Friendly subtitles per resolved status — drives the colored header band.
const STATUS_SUBTITLES: Record<string, string> = {
  accepted: 'Confirm you want to accept this request.',
  rejected: 'Let the other party know why this is being declined.',
  cancelled: 'Withdraw this request — both parties will be notified.',
  completed: 'Mark this as complete once everything is finished.',
};

export function ActionStatusUpdater({
  action,
  open,
  onOpenChange,
  suggestedStatus,
}: ActionStatusUpdaterProps) {
  const isMobile = useIsMobile();
  const { mutate: updateStatus, isPending } = useUpdateActionStatus();

  const [status, setStatus] = React.useState(suggestedStatus ?? '');
  const [remarks, setRemarks] = React.useState('');

  React.useEffect(() => {
    if (open && action) {
      setStatus(suggestedStatus ?? getValidTransitions(action.action_status)[0] ?? '');
      setRemarks('');
    }
  }, [open, action, suggestedStatus]);

  if (!action) return null;

  const validTransitions = getValidTransitions(action.action_status);

  const handleSubmit = () => {
    if (!status) {
      toast.error('No status selected', {
        description: 'Choose a new status from the dropdown before submitting.',
      });
      return;
    }

    updateStatus(
      {
        action_id: action.action_id,
        action_status: status,
        remarks: remarks || undefined,
      },
      {
        onSuccess: () => {
          toast.success(`Action ${statusLabels[status]?.toLowerCase() ?? status}`, {
            description: 'The status has been updated and both parties will be notified.',
          });
          onOpenChange(false);
        },
        onError: (error: Error) => {
          toast.error(`Failed to update status: ${error.message}`);
        },
      }
    );
  };

  const formContent = (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="status">New Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger id="status">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            {validTransitions.map((s) => (
              <SelectItem key={s} value={s}>
                {statusLabels[s] ?? s.charAt(0).toUpperCase() + s.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="remarks">Remarks (Optional)</Label>
        <Input
          id="remarks"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Add any notes about this status change..."
        />
      </div>
    </div>
  );

  // Drive the header band from the currently selected target status — falls
  // back to the action type when nothing's chosen yet (the typical "first paint").
  const headerKey = status || action.action_type || 'connect';
  const display = getActionDisplay(headerKey);
  const actionLabel = statusLabels[status] ?? display.label;
  const subtitle = STATUS_SUBTITLES[status] ?? `Update status for this ${action.action_type ?? 'action'}`;

  const header = (
    <ActionModalHeader
      actionKey={headerKey}
      title={status ? `${actionLabel} Request` : 'Update Status'}
      description={subtitle}
      fromDomain={action.source_item_domain}
      toDomain={action.target_item_domain}
    />
  );

  const footer = (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
        Cancel
      </Button>
      <Button
        onClick={handleSubmit}
        disabled={isPending || !status}
        className={cn('min-w-[120px] rounded-full font-semibold shadow-sm', display.buttonClass)}
      >
        {isPending ? 'Updating...' : actionLabel}
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90vh] overflow-hidden p-0">
          <div className="px-6 pt-6">{header}</div>
          <div className="px-6 pb-4 overflow-y-auto">{formContent}</div>
          <div className="border-t px-6 py-4">{footer}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto gap-0 p-6">
        {header}
        <div className="py-4">{formContent}</div>
        {footer}
      </DialogContent>
    </Dialog>
  );
}
