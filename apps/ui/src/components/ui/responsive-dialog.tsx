import * as React from 'react';
import { XIcon } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerClose, DrawerTitle } from '@/components/ui/drawer';

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  // Desktop DialogContent only.
  contentClassName?: string;
  // Accessible name for the mobile Drawer, rendered as a sr-only DrawerTitle.
  // vaul bundles its own @radix-ui/react-dialog, so a DialogTitle in
  // `children` registers with the wrong context and leaves the sheet unnamed.
  title?: React.ReactNode;
  // Whether an X close button renders, on both shapes.
  showCloseButton?: boolean;
  // Whether outside click, swipe, Esc or backdrop can dismiss, on both
  // shapes. Explicit rather than inferred from the guard callbacks, so passive
  // guards cannot trap a Drawer. Default true.
  dismissible?: boolean;
  // Forwarded to both shapes' Radix Dialog.Content. On the Drawer,
  // `preventDefault()` here does not block dismissal; set
  // `dismissible={false}` too.
  onInteractOutside?: (e: Event) => void;
  onEscapeKeyDown?: (e: Event) => void;
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  children,
  contentClassName,
  title,
  showCloseButton = true,
  dismissible = true,
  onInteractOutside,
  onEscapeKeyDown,
}: ResponsiveDialogProps): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} dismissible={dismissible}>
        <DrawerContent
          className="max-h-[90dvh] overflow-hidden p-0"
          onInteractOutside={onInteractOutside}
          onEscapeKeyDown={onEscapeKeyDown}
        >
          {title && <DrawerTitle className="sr-only">{title}</DrawerTitle>}
          {showCloseButton && (
            <DrawerClose className="absolute top-4 right-4 z-10 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
              <XIcon />
              <span className="sr-only">Close</span>
            </DrawerClose>
          )}
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
