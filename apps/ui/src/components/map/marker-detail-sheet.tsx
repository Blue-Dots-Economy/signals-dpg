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
 * The phone map's marker details: a titled bottom sheet (`ResponsiveDialog`)
 * over the full-size card, like `ProfileCardModal`, instead of the provider's
 * popup bubble. The body is a scrolling block, not a flex column, because a
 * flex item with `overflow-hidden` (the card's root) shrinks and clips its own
 * "View more details".
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
