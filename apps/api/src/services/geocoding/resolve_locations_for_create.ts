import {
  getDomainItemSchema,
  isLocationFieldPrivate,
  parseLocationFields,
  buildLocationQueries,
} from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import { resolveCoordinates, resolveCityCenter } from './geo_resolver';

type ItemLocation = { lat: number; lng: number; label?: string };

interface ResolveLocationsForCreateArgs {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  /** Coordinates supplied by the caller (e.g. the UI resolved them client-side). */
  provided?: ItemLocation[];
  /** Optional logger; a geocoding failure is warned and treated as "no coords". */
  log?: { warn: (obj: unknown, msg: string) => void };
}

/**
 * Resolves the coordinates to store for a NEW item from its address/location
 * field, when the caller supplied none. Shared by the public `/item/create`
 * route and the admin-participant onboarding path (`create_profile_item`) so
 * both store `item_locations` identically.
 *
 * Rules (mirrors the original inline logic in create_item):
 *  - `provided` non-empty → used as-is (never geocoded over).
 *  - Private (PII) location field → resolve only to the city centre.
 *  - Public location field(s) → geocode each marked query to its exact point.
 *  - Best-effort: any failure returns `provided ?? []` (item created without coords).
 */
export async function resolveLocationsForCreate(
  args: ResolveLocationsForCreateArgs,
): Promise<ItemLocation[]> {
  const provided = args.provided ?? [];
  if (provided.length > 0) return provided;

  try {
    const networkConfig = await getNetworkConfigById(args.item_network);
    const itemSchema = getDomainItemSchema(
      networkConfig,
      args.item_domain,
      args.item_type,
    ) as Record<string, unknown> | null;
    if (!itemSchema) return [];

    if (isLocationFieldPrivate(itemSchema)) {
      // Private (PII) field: resolve only to the city centre — never the exact
      // address — from the marked address field.
      const { field } = parseLocationFields(itemSchema);
      const address = field ? args.item_state[field] : undefined;
      if (typeof address === 'string' && address.trim()) {
        const center = await resolveCityCenter(address);
        if (center) return [center];
      }
      return [];
    }

    // Public field(s): geocode each marked query to its exact point.
    const fields = parseLocationFields(itemSchema);
    const queries = buildLocationQueries(args.item_state, fields);
    const out: ItemLocation[] = [];
    for (const { query, label } of queries) {
      const coord = await resolveCoordinates(query);
      if (coord) out.push(label ? { ...coord, label } : coord);
    }
    return out;
  } catch (err) {
    args.log?.warn(
      { err, item_network: args.item_network, item_domain: args.item_domain },
      'backend geocoding failed; creating item without coordinates',
    );
    return provided;
  }
}
