import * as React from 'react';
import { XIcon } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerClose } from '@/components/ui/drawer';

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  // forwarded to DialogContent on desktop; ignored by the Drawer body
  contentClassName?: string;
  // Whether an X close affordance renders — honored on BOTH shapes (previously
  // silently dropped on the mobile Drawer, which also hid it in `view` mode).
  showCloseButton?: boolean;
  // Whether outside-click/swipe/Esc/backdrop can dismiss — honored on BOTH
  // shapes. Explicit rather than inferred from the guard callbacks below, so a
  // consumer that just wants the guard callbacks as passive hooks (without
  // blocking dismissal) doesn't accidentally trap a mobile Drawer. Defaults to
  // true (matches the prior un-guarded default for every consumer that never
  // set this).
  dismissible?: boolean;
  // Guard callbacks forwarded to both shapes' underlying radix Dialog.Content
  // (vaul spreads DrawerContent's extra props onto it). Passing `dismissible`
  // is what actually blocks swipe/backdrop/Esc dismissal on the Drawer; these
  // callbacks alone do NOT block it there (unlike desktop, where
  // `preventDefault()` inside them is sufficient) — set `dismissible={false}`
  // too when full non-dismissal is required.
  onInteractOutside?: (e: Event) => void;
  onEscapeKeyDown?: (e: Event) => void;
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  children,
  contentClassName,
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
          {showCloseButton && (
            <DrawerClose
              className="absolute top-4 right-4 z-10 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
              aria-label="Close"
            >
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
