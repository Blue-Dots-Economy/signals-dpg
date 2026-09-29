import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';

interface MarkerDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item's title — the sheet heading, and its accessible name. */
  title: string;
  /** The card (and its actions) for the tapped marker. */
  children: React.ReactNode;
}

/**
 * The phone map's marker details (#745): tapping a pin opens the item from the
 * bottom, the same way My Actions' "View profile" does (`ProfileCardModal`) —
 * a titled sheet with the "public profile" line over the full-size card —
 * instead of the provider's small popup bubble over the map.
 *
 * Built on `ResponsiveDialog`, so it is the vaul bottom Drawer on a phone.
 * The body is a scrolling BLOCK, not a flex column, for the reason spelled
 * out in `ProfileCardModal` (#507): a flex item with `overflow-hidden` (the
 * card's root) shrinks below its content and clips its own "View more details".
 */
export function MarkerDetailSheet({ open, onOpenChange, title, children }: Readonly<MarkerDetailSheetProps>) {
  const { t } = useTranslation();
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={title} contentClassName="max-w-xl">
      <div className="space-y-4 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('profile.card_desc_masked')}</DialogDescription>
        </DialogHeader>
        {children}
      </div>
    </ResponsiveDialog>
  );
}
