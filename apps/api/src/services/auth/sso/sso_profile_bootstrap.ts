import type { FastifyBaseLogger } from 'fastify';
import type { SsoNcsMapping } from '@dpg/config';
import { db } from '@api/db/postgres/drizzle_config';
import { create_profile_item } from '@/lib/profile_item';
import { tagUserWithDefaultAggregator } from '@/services/aggregator/default_aggregator';
import { countActiveProfiles } from '@/services/item_service';
import type { SsoIdentity } from '@/services/auth/sso/types';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { publishItemEvent } from '@/utils/publish_item_event';
import {
  isServedDomainBinding,
  resolveServedNetworkForDomain,
} from '@/utils/served_domain_guard';

/**
 * Create a starter profile from a verified partner login, so the user lands on
 * "My Profiles" with something to complete rather than an empty page.
 *
 * - Only when the user has no active profile of that type in that domain —
 *   a later partner login never overwrites what the user has edited.
 * - Through the normal create path (`create_profile_item` →
 *   `createItemInternal`), so schema validation, PII encryption, the profile
 *   cap, the single-domain lock and URL generation all apply unchanged.
 * - Always `draft`: the partner supplies a few fields, and go-live still
 *   needs the rest plus consent (and, for a minor, the guardian).
 * - Never throws. A failure here must not fail a login that already
 *   succeeded; the user can still create the profile by hand.
 */

export type SsoProfileMapping = Pick<
  SsoNcsMapping,
  'network' | 'item_type' | 'role_to_domain' | 'fields'
>;

/** The partner's phone field is stored in its normalised E.164 form. */
const PHONE_SOURCE_FIELDS = new Set(['mobileNumber']);

function mapFields(
  identity: SsoIdentity,
  fields: Record<string, string>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [source, target] of Object.entries(fields)) {
    const value = PHONE_SOURCE_FIELDS.has(source)
      ? identity.phone
      : identity.attributes[source];
    if (value === undefined || value === null || value === '') continue;
    payload[target] = value;
  }
  return payload;
}

export async function bootstrapSsoProfile(
  userId: string,
  identity: SsoIdentity,
  mapping: SsoProfileMapping,
  log: FastifyBaseLogger
): Promise<{ created: true; itemId: string } | { created: false }> {
  const domain = identity.role ? mapping.role_to_domain[identity.role] : undefined;
  if (!domain) return { created: false };

  const network = mapping.network ?? resolveServedNetworkForDomain(domain);
  if (!network || !isServedDomainBinding(network, domain)) {
    log.warn({ domain, network }, 'sso: profile bootstrap skipped — domain not served here');
    return { created: false };
  }

  const scope = {
    created_by: userId,
    item_network: network,
    item_domain: domain,
    item_type: mapping.item_type,
  };

  try {
    const itemId = await db.transaction(async (tx) => {
      if ((await countActiveProfiles(tx, scope)) > 0) return null;
      // Same order as /item/create: owner first, so the go-live gate that
      // reads it sees the tag when the item is classified.
      await tagUserWithDefaultAggregator(tx, userId, network, domain);
      const { item_id } = await create_profile_item({
        tx,
        user_id: userId,
        network,
        domain,
        item_type: mapping.item_type,
        payload: mapFields(identity, mapping.fields),
      });
      return item_id;
    });

    if (!itemId) return { created: false };

    // After commit, as every create path does (#557).
    await publishItemEvent(
      {
        item_network: network,
        item_domain: domain,
        item_type: mapping.item_type,
        item_id: itemId,
        op: 'upsert',
      },
      log
    );
    await invalidateItemFetchCache(network, domain).catch((err) =>
      log.warn({ err }, 'sso: cache invalidation after profile bootstrap failed')
    );

    log.info(
      { user_id: userId, item_id: itemId, provider: identity.provider },
      'sso: created draft profile from partner details'
    );
    return { created: true, itemId };
  } catch (err) {
    log.error(
      { err, user_id: userId, provider: identity.provider },
      'sso: profile bootstrap failed'
    );
    return { created: false };
  }
}
