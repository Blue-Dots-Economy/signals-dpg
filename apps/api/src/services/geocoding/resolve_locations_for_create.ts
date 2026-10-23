import {
  getDomainItemSchema,
  parseLocationFields,
  buildLocationQueries,
} from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import { resolveCoordinates } from './geo_resolver';

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
 * Geocodes an item's primary location field from its full item_state, to the
 * exact point for both private and public fields. Any failure returns [].
 */
export async function geocodeLocationsFromState(
  itemSchema: Record<string, unknown>,
  item_state: Record<string, unknown>,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<ItemLocation[]> {
  try {
    const { primary } = parseLocationFields(itemSchema);
    // A private field is jittered at storage time in item_service, so the
    // exact coordinate is never persisted.
    const queries = buildLocationQueries(item_state, primary);
    const out: ItemLocation[] = [];
    for (const { query, label } of queries) {
      const coord = await resolveCoordinates(query);
      if (coord) out.push(label ? { ...coord, label } : coord);
    }
    return out;
  } catch (err) {
    log?.warn({ err }, 'geocoding failed');
    return [];
  }
}

/**
 * Resolves the coordinates to store for a new item from its location field.
 * Shared by `/item/create` and `create_profile_item` so both store
 * `item_locations` identically.
 *
 *  - A non-empty `provided` is used as-is, never geocoded over.
 *  - Best-effort: any failure returns [] and the item is created without
 *    coordinates.
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

    return await geocodeLocationsFromState(itemSchema, args.item_state, args.log);
  } catch (err) {
    args.log?.warn(
      { err, item_network: args.item_network, item_domain: args.item_domain },
      'backend geocoding failed; creating item without coordinates',
    );
    return provided;
  }
}
