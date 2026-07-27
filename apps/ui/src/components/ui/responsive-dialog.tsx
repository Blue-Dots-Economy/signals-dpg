import * as React from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Drawer, DrawerContent } from '@/components/ui/drawer';

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  // forwarded to DialogContent on desktop; ignored by the Drawer body
  contentClassName?: string;
  showCloseButton?: boolean;
  // guards that must survive on both shapes (consent gate blocks dismissal)
  onInteractOutside?: (e: Event) => void;
  onEscapeKeyDown?: (e: Event) => void;
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  children,
  contentClassName,
  showCloseButton = true,
  onInteractOutside,
  onEscapeKeyDown,
}: ResponsiveDialogProps): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90dvh] overflow-hidden p-0">
          {children}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={showCloseButton}
        className={cn('flex max-h-[90dvh] flex-col overflow-hidden p-0', contentClassName)}
        onInteractOutside={onInteractOutside}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
