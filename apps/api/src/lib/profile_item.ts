/**
 * Thin onboarding-time wrapper around the canonical item-create service.
 *
 * The onboarding route (POST /api/v1/admin/participant) creates a
 * user and a profile item in one transaction. This helper lets that route
 * invoke the same `createItemInternal` path the public /item/create route
 * uses, so participant profile items go through identical validation +
 * partition setup + URL generation.
 *
 * Inputs are kept narrow: the caller passes the user_id (the participant
 * becomes the owner), the network/domain/item_type for the profile
 * schema, and the payload. The helper hands these to createItemInternal
 * with `created_by: user_id` (the participant authors their own row).
 */
import {
  createItemInternal,
  type DbOrTx,
  type ItemLocation,
} from '@/services/item_service';
import { resolveLocationsForCreate } from '@/services/geocoding/resolve_locations_for_create';

export interface CreateProfileItemInput {
  /**
   * Drizzle transaction (or db client) passed in by the caller so the
   * item insert joins the same atomic block as the user insert. The
   * `DbOrTx` type is re-exported from `@/services/item_service` and
   * matches the parameter `createItemInternal` already accepts.
   */
  tx: DbOrTx;

  user_id: string;
  network: string; // e.g. 'blue_dot'
  domain: string; // e.g. 'seeker'
  item_type: string; // e.g. 'profile_1.0'
  payload: Record<string, unknown>;

  /**
   * Coordinates the caller already resolved for this item (e.g. the address
   * the participant picked from an autocomplete on the aggregator's
   * registration form). Non-empty → stored as-is, and the address text in
   * `payload` is not geocoded. Absent/empty → geocoded server-side, the
   * historical behaviour. Either way a private location field is jittered
   * downstream in `createItemInternal`, so supplying coords here cannot
   * persist an exact private address.
   */
  item_locations?: ItemLocation[];
}

export interface CreateProfileItemResult {
  item_id: string;
}

export const create_profile_item = async (
  input: CreateProfileItemInput,
): Promise<CreateProfileItemResult> => {
  // Geocode the profile's address/location field into item_locations, the same
  // way the public /item/create route does — otherwise items onboarded via the
  // admin-participant API (e.g. the aggregator) would be stored with no
  // coordinates, and downstream "Get Directions"/distance features would break.
  // Coordinates the caller resolved itself take precedence and are never
  // geocoded over (see resolveLocationsForCreate).
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
