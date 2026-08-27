import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Share2 } from 'lucide-react';
import type { Item } from '@/lib/item-api';
import { ShareProfileDialog } from '@/components/share/share-profile-dialog';

export interface ShareProfileButtonProps {
  /** The profile to share. The button renders only when this is a LIVE item. */
  item:
    | Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id' | 'lifecycle_status'>
    | null
    | undefined;
  /** Optional button styling override (e.g. white on a coloured card header). */
  className?: string;
  /**
   * Optional visible text next to the icon. Icon-only (the card/row default)
   * when omitted; the public profile page passes a label because its share
   * affordance is a labelled pill in the app bar.
   */
  label?: React.ReactNode;
}

/**
 * Share affordance shown ONLY on live profiles. Opens `ShareProfileDialog`,
 * which offers the profile's public link as a scannable QR plus "Copy link"
 * and "Download QR". Renders null for a missing or non-live item, so call
 * sites can drop it in unconditionally — a paused/retired/draft profile gets
 * no share and no QR, matching the public page, which only serves live items
 * (the item endpoint filters `live_only` server-side).
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
