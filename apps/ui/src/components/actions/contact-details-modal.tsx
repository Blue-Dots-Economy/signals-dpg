import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  getActionContactDetails,
  type ContactDetailsResponse,
} from '@/lib/action-api';

interface ContactDetailsModalProps {
  actionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const errorMessages: Record<string, string> = {
  PII_NOT_REVEALED:
    'Contact details are no longer available for this connection.',
  CROSS_INSTANCE_REVEAL_NOT_SUPPORTED:
    "This contact is hosted on another instance and isn't supported yet.",
  NOT_ACTION_PARTICIPANT: "You don't have access to these details.",
  UNAUTHORIZED: "You don't have access to these details.",
  ACTION_NOT_FOUND: 'This action no longer exists.',
  OTHER_ITEM_NOT_FOUND: 'Something went wrong; please try again.',
  INTERNAL_SERVER_ERROR: 'Something went wrong; please try again.',
};

type ModalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ContactDetailsResponse }
  | { status: 'error'; code: string; message: string };

export function ContactDetailsModal({
  actionId,
  open,
  onOpenChange,
}: ContactDetailsModalProps) {
  const [state, setState] = React.useState<ModalState>({ status: 'idle' });

  React.useEffect(() => {
    if (!open) {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    getActionContactDetails(actionId)
      .then((data) => {
        if (!cancelled) setState({ status: 'success', data });
      })
      .catch((err: Error & { code?: string }) => {
        if (cancelled) return;
        const code = err.code ?? 'INTERNAL_SERVER_ERROR';
        setState({
          status: 'error',
          code,
          message: errorMessages[code] ?? err.message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [open, actionId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Contact details</DialogTitle>
          <DialogDescription>
            Shared once the connection is accepted.
          </DialogDescription>
        </DialogHeader>

        {state.status === 'loading' && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}

        {state.status === 'error' && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm font-semibold text-destructive">
              Couldn&apos;t load contact details
            </p>
            <p className="mt-1 text-sm text-destructive/80">{state.message}</p>
          </div>
        )}

        {state.status === 'success' && (
          <div className="space-y-2">
            <pre className="overflow-auto max-h-80 rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(state.data.other_actor.item.item_state, null, 2)}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
