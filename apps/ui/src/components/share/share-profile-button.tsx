import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Share2 } from 'lucide-react';
import type { Item } from '@/lib/item-api';
import { ShareProfileDialog } from '@/components/share/share-profile-dialog';

export interface ShareProfileButtonProps {
  /** The profile to share. The button renders only for a live item. */
  item:
    | Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id' | 'lifecycle_status'>
    | null
    | undefined;
  /** Optional button styling override (e.g. white on a coloured card header). */
  className?: string;
  /** Visible text next to the icon; icon-only when omitted. */
  label?: React.ReactNode;
}

/**
 * Opens `ShareProfileDialog` for a live profile. Renders null otherwise, since
 * the public page only serves live items, so call sites can use it
 * unconditionally.
 */
export function ShareProfileButton({ item, className, label }: Readonly<ShareProfileButtonProps>) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  if (item?.lifecycle_status !== 'live') return null;

  const onShare = (e: React.MouseEvent) => {
    // Card and row call sites wrap the button in a clickable container.
    e.stopPropagation();
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={onShare}
        aria-label={t('share.button', 'Share profile')}
        title={t('share.button', 'Share profile')}
        className={
          className ??
          'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'
        }
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        {label}
      </button>
      <ShareProfileDialog item={item} open={open} onOpenChange={setOpen} />
    </>
  );
}
