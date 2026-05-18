import * as React from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Action } from '@/lib/action-api';

// Desktop: Dialog
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';

import { useUpdateActionStatus } from '@/hooks/use-actions';
import { toast } from 'sonner';

interface ActionStatusUpdaterProps {
  action: Action | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestedStatus?: string;
}

// Valid status transitions based on current status
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

  // Reset form when action changes or modal opens
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
      toast.error('Please select a status');
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
          toast.success(`Action ${statusLabels[status]?.toLowerCase() ?? status} successfully`);
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
      {/* Status Selection */}
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

      {/* Remarks */}
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

  const actionLabel = statusLabels[status] ?? 'Update';

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader>
            <DrawerTitle>Update Action Status</DrawerTitle>
            <DrawerDescription>
              {action.action_type} from {action.source_item_domain} → {action.target_item_domain}
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-4 overflow-y-auto">{formContent}</div>
          <DrawerFooter>
            <Button onClick={handleSubmit} disabled={isPending || !status}>
              {isPending ? 'Updating...' : actionLabel}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Update Action Status</DialogTitle>
          <DialogDescription>
            {action.action_type} from {action.source_item_domain} → {action.target_item_domain}
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">{formContent}</div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending || !status}>
            {isPending ? 'Updating...' : actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
