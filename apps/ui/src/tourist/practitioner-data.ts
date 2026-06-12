import type { Item, ItemLocation } from '@/lib/item-api';
import type { LatLng } from '@/lib/geo/types';

export interface CardItem {
  id: string;
  domain: string;
  data: Record<string, unknown>;
}

/** Map an API Item to the {id,domain,data} shape MapView/ItemCard consume. */
export function itemToCardItem(item: Item): CardItem {
  return {
    id: item.item_id,
    domain: item.item_domain,
    data: { ...item.item_state, item_locations: item.item_locations },
  };
}

/**
 * A listing whose description contains "Powered by RubiX" is sourced from
 * RubiX — it gets the RubiX favicon (card avatar + map pin) and only the
 * Explore action.
 */
const RUBIX_RE = /powered\s*by\s*rubix/i;

export function isRubixListing(data: Record<string, unknown>): boolean {
  return typeof data.description === 'string' && RUBIX_RE.test(data.description);
}

/** First location point (exact for orange practitioners), or null. */
export function getPrimaryLocation(
  locations: ItemLocation[] | undefined,
): (LatLng & { label?: string }) | null {
  const first = locations?.[0];
  return first ? { lat: first.lat, lng: first.lng, label: first.label } : null;
}

/** Case-insensitive substring match across an item's string field values. */
export function matchesSearch(data: Record<string, unknown>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'item_locations') continue;
    if (typeof value === 'string' && value.toLowerCase().includes(q)) return true;
    if (Array.isArray(value) && value.some((v) => typeof v === 'string' && v.toLowerCase().includes(q))) return true;
  }
  return false;
}
