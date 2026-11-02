/**
 * Onboarding wrapper around `createItemInternal` for
 * POST /api/v1/admin/participant, so participant profiles get the same
 * validation, locks and URL generation as /item/create. The participant
 * (`user_id`) owns the created item.
 */
import {
  assertSuppliedLocationsInCountry,
  createItemInternal,
  type DbOrTx,
  type ItemLocation,
} from '@/services/item_service';
import { resolveLocationsForCreate } from '@/services/geocoding/resolve_locations_for_create';

export interface CreateProfileItemInput {
  /** The caller's transaction, so the item insert is atomic with the user insert. */
  tx: DbOrTx;

  user_id: string;
  network: string; // e.g. 'blue_dot'
  domain: string; // e.g. 'seeker'
  item_type: string; // e.g. 'profile_1.0'
  payload: Record<string, unknown>;

  /**
   * Coordinates the caller already resolved for this item (e.g. the address
   * the participant picked from an autocomplete on the aggregator's
   * registration form). Non-empty: used instead of geocoding the address text
   * in `payload`. Absent/empty: geocoded server-side. Either way a private
   * location field is jittered in `createItemInternal`, so an exact private
   * address is never persisted.
   */
  item_locations?: ItemLocation[];
}

export interface CreateProfileItemResult {
  item_id: string;
}

export const create_profile_item = async (
  input: CreateProfileItemInput,
): Promise<CreateProfileItemResult> => {
  // Caller-resolved coordinates skip the geocoder, so they are checked against
  // the configured country here (throws LOCATION_OUTSIDE_COUNTRY, a 400).
  await assertSuppliedLocationsInCountry(input.item_locations);
  const item_locations = await resolveLocationsForCreate({
    item_network: input.network,
    item_domain: input.domain,
    item_type: input.item_type,
    item_state: input.payload,
    provided: input.item_locations,
  });

  const result = await createItemInternal(input.tx, {
    item_network: input.network,
    item_domain: input.domain,
    item_type: input.item_type,
    item_state: input.payload,
    item_locations,
    created_by: input.user_id,
  });

  return { item_id: result.itemId };
};
