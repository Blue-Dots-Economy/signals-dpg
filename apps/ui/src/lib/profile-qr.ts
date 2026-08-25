import QRCode from 'qrcode';
import type { Item } from '@/lib/item-api';
import { buildProfileShareUrl } from '@/lib/share-profile';

/** The item key fields a share QR is built from — nothing from `item_state`. */
export type ProfileQrItem = Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id'>;

/**
 * The ONE set of encoder options used for every profile QR, in every call site.
 *
 * These must stay fixed. The rendered image is a pure function of
 * (share URL, these options) — change any of them and every profile's QR
 * renders differently, so a code already printed on a poster, a badge or a
 * flyer would no longer match the one the app hands out today. Nothing about a
 * QR is stored anywhere (no DB column, no object storage, no server round
 * trip); "the same QR every time" is guaranteed by regenerating from the same
 * inputs, which only holds while these values are constant.
 *
 * Deliberately module-level and frozen rather than a prop/parameter: no call
 * site may pass its own width or error-correction level.
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Download filename for a profile's QR: `<network>-<domain>-<itemId>.png`.
 *
 * Built only from the item's key. It deliberately carries NO profile content:
 * every human-readable field (name, title, description) lives in `item_state`,
 * which is exactly what the public projection masks — a name-based filename
 * would leak, through the file on someone's disk, the very thing the public
 * page hides. The item id is included so a user downloading several QRs gets
 * distinct files instead of `file (1).png`, `file (2).png`.
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
 * `buildProfileShareUrl` produces — no token, nonce, timestamp or counter is
 * added, so the same profile always yields the same image.
 */
export function generateProfileQrDataUrl(item: ProfileQrItem): Promise<string> {
  // Spread, don't pass the frozen object: `qrcode`'s renderer normalises the
  // options in place (`if (!options.color) options.color = {}`), and writing to
  // a frozen object is a silent no-op in its non-strict CommonJS, after which
  // it dereferences the property it thought it had just created and throws.
  // The copy is per-call and carries the same values, so the output is
  // unchanged — the constant stays the single source of truth.
  return QRCode.toDataURL(buildProfileShareUrl(item), { ...PROFILE_QR_OPTIONS });
}

/**
 * Save a data URL to disk under `filename` via a synthetic anchor click. Kept
 * here (rather than inline in the dialog) so the component stays declarative
 * and this DOM detail is testable on its own.
 */
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
