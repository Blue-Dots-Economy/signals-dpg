import QRCode from 'qrcode';
import type { Item } from '@/lib/item-api';
import { buildProfileShareUrl } from '@/lib/share-profile';

/** The item key fields a share QR is built from — nothing from `item_state`. */
export type ProfileQrItem = Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id'>;

/**
 * The one set of encoder options for every profile QR. Fixed and frozen so the
 * image is a pure function of the share URL: regenerating yields the same
 * image, which is why nothing is stored. Printed QRs depend only on the encoded
 * URL, so changing these is a visual change, not a breaking one.
 */
export const PROFILE_QR_OPTIONS = Object.freeze({
  errorCorrectionLevel: 'M',
  margin: 1,
  width: 512,
} as const);

/**
 * Lowercase, hyphen-separated, filesystem-safe form of one filename segment.
 * Collapses every run of non-alphanumerics (including the `_` in network ids
 * like `blue_dot`) to a single `-`.
 */
function kebabSegment(value: string): string {
  // Split rather than replace-then-trim: a trailing-anchored `-+$` trim
  // backtracks super-linearly (SonarCloud typescript:S8786).
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');
}

/**
 * Download filename for a profile's QR: `<network>-<domain>-<itemId>.png`.
 *
 * Built only from the item's key, never from `item_state`: names and titles
 * are what the public projection masks, so a name-based filename would leak
 * them. The item id keeps several downloads distinct.
 */
export function buildProfileQrFilename(item: ProfileQrItem): string {
  const stem = [item.item_network, item.item_domain, item.item_id]
    .map(kebabSegment)
    .filter(Boolean)
    .join('-');
  return `${stem || 'profile'}.png`;
}

/**
 * PNG data URL of the profile's share QR, encoding exactly the URL
 * `buildProfileShareUrl` produces with nothing per-call added, so the same
 * profile always yields the same image.
 */
export function generateProfileQrDataUrl(item: ProfileQrItem): Promise<string> {
  // Pass a copy: `qrcode` mutates its options in place, which silently fails on
  // a frozen object and then throws.
  return QRCode.toDataURL(buildProfileShareUrl(item), { ...PROFILE_QR_OPTIONS });
}

/** Save a data URL to disk under `filename` via a synthetic anchor click. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
