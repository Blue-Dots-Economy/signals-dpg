import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Share2 } from 'lucide-react';
import type { Item } from '@/lib/item-api';
import { buildProfileShareUrl, copyTextToClipboard } from '@/lib/share-profile';

export interface ShareProfileButtonProps {
  /** The profile to share. The button renders only when this is a LIVE item. */
  item:
    | Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id' | 'lifecycle_status'>
    | null
    | undefined;
  /** Optional button styling override (e.g. white on a coloured card header). */
  className?: string;
}

/**
 * Copy-link Share affordance shown ONLY on live profiles. Copies the canonical
 * public share URL and toasts success/failure. Renders null for a missing or
 * non-live item, so call sites can drop it in unconditionally.
 */
export function ShareProfileButton({ item, className }: ShareProfileButtonProps) {
  const { t } = useTranslation();
  if (!item || item.lifecycle_status !== 'live') return null;

  const onShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyTextToClipboard(buildProfileShareUrl(item));
    if (ok) toast.success(t('share.copied', 'Link copied to clipboard'));
    else toast.error(t('share.copy_failed', 'Could not copy the link'));
  };

  return (
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
      <Share2 className="h-4 w-4" />
    </button>
  );
}
