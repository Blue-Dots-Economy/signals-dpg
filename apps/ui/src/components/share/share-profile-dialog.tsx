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
 * Share sheet for a live profile: the share link rendered as a QR code, plus
 * "Copy link" and "Download QR".
 *
 * The QR is shown on screen deliberately — the common case is holding the
 * phone up for the person in front of you to scan, not downloading a file.
 * Download is the secondary path (print it, put it on a flyer).
 *
 * There is intentionally no "copy QR image" action: Firefox cannot write image
 * data to the clipboard at all, and an action that silently fails for an entire
 * browser is worse than one we never offered.
 *
 * The image is generated in the browser from `buildProfileShareUrl` with the
 * fixed `PROFILE_QR_OPTIONS` — no API call, no storage. Generating it again
 * later reproduces the same code, so a QR printed months ago still works.
 */
export function ShareProfileDialog({
  item,
  open,
  onOpenChange,
}: Readonly<ShareProfileDialogProps>) {
  const { t } = useTranslation();
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  // Narrow to the four key fields, memoised on their values. Call sites build
  // the `item` object inline, so depending on the object identity below would
  // re-encode on every render (and, since encoding sets state, never settle).
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

  // Encode only while the dialog is open — a card grid can mount dozens of
  // share buttons, and none of them should be rasterising a 512px QR upfront.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
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
          {/* Not disabled while the QR is still encoding: encoding is
              near-instant, and a silently disabled button explains nothing if
              it ever fails. `onDownload` toasts instead. */}
          <Button type="button" className="flex-1" onClick={onDownload}>
            <Download className="h-4 w-4" aria-hidden="true" />
            {t('share.download_qr', 'Download QR')}
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
