import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertCircle, Copy, Download, Loader2 } from 'lucide-react';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { buildProfileShareUrl, copyTextToClipboard } from '@/lib/share-profile';
import {
  buildProfileQrFilename,
  downloadDataUrl,
  generateProfileQrDataUrl,
  type ProfileQrItem,
} from '@/lib/profile-qr';

export interface ShareProfileDialogProps {
  item: ProfileQrItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Share sheet for a live profile: the link as an on-screen QR (to be scanned
 * from the phone), "Copy link" and "Download QR". No "copy QR image": Firefox
 * cannot write images to the clipboard.
 *
 * The QR is generated in the browser from `buildProfileShareUrl` with fixed
 * `PROFILE_QR_OPTIONS`, so it is reproducible and a printed QR keeps working.
 */
export function ShareProfileDialog({
  item,
  open,
  onOpenChange,
}: Readonly<ShareProfileDialogProps>) {
  const { t } = useTranslation();
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  // Memoised on the four key values: call sites build `item` inline, and
  // depending on its identity would re-encode on every render, never settling.
  const qrItem = React.useMemo<ProfileQrItem>(
    () => ({
      item_network: item.item_network,
      item_domain: item.item_domain,
      item_type: item.item_type,
      item_id: item.item_id,
    }),
    [item.item_network, item.item_domain, item.item_type, item.item_id],
  );

  const shareUrl = buildProfileShareUrl(qrItem);

  // Encode only while open, since a card grid mounts many share buttons.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
    // Clear the previous QR too, so a changed `item` can never show or
    // download the old profile's QR.
    setDataUrl(null);
    generateProfileQrDataUrl(qrItem)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, qrItem]);

  const onCopy = async () => {
    const ok = await copyTextToClipboard(shareUrl);
    if (ok) toast.success(t('share.copied', 'Link copied to clipboard'));
    else toast.error(t('share.copy_failed', 'Could not copy the link'));
  };

  const onDownload = () => {
    if (!dataUrl) {
      toast.error(t('share.qr_download_failed', 'Could not prepare the QR code'));
      return;
    }
    downloadDataUrl(dataUrl, buildProfileQrFilename(qrItem));
    toast.success(t('share.qr_downloaded', 'QR code downloaded'));
  };

  const title = t('share.qr_title', 'Share profile');

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      contentClassName="sm:max-w-sm"
    >
      <div className="flex flex-col gap-4 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t('share.qr_description', 'Scan this code, or share the link to this profile.')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center rounded-xl border border-border bg-white p-4">
          {(() => {
            if (failed) {
              return (
                <p className="flex h-40 items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  {t('share.qr_failed', 'Could not generate the QR code')}
                </p>
              );
            }
            if (!dataUrl) {
              return (
                <div className="flex h-40 items-center justify-center">
                  <Loader2
                    className="h-6 w-6 animate-spin text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
              );
            }
            return (
              <img
                src={dataUrl}
                alt={t('share.qr_alt', 'QR code linking to this profile')}
                className="h-40 w-40 sm:h-52 sm:w-52"
              />
            );
          })()}
        </div>

        <p className="break-all text-center text-xs text-muted-foreground">{shareUrl}</p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="flex-1" onClick={onCopy}>
            <Copy className="h-4 w-4" aria-hidden="true" />
            {t('share.copy_link', 'Copy link')}
          </Button>
          {/* Not disabled while encoding; `onDownload` toasts if the QR is
              not ready. */}
          <Button type="button" className="flex-1" onClick={onDownload}>
            <Download className="h-4 w-4" aria-hidden="true" />
            {t('share.download_qr', 'Download QR')}
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
