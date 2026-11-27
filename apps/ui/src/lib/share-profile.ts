import type { Item } from '@/lib/item-api';

/**
 * Canonical public share URL for a profile, built from its key. Carries
 * `?network=` because the theme provider resolves the network from that query
 * param, so a cold-loaded link renders in the profile's own theme.
 */
export function buildProfileShareUrl(
  item: Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id'>,
  origin: string = window.location.origin,
): string {
  const seg = (s: string) => encodeURIComponent(s);
  const path = `/public/${seg(item.item_network)}/${seg(item.item_domain)}/${seg(item.item_type)}/${seg(item.item_id)}`;
  return `${origin}${path}?network=${seg(item.item_network)}`;
}

/**
 * Copy text to the clipboard via the Clipboard API, falling back to a hidden
 * textarea + `execCommand('copy')` when it is missing or rejects. Returns true
 * on success.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  let ta: HTMLTextAreaElement | undefined;
  try {
    ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (ta?.parentNode) ta.remove();
  }
}
