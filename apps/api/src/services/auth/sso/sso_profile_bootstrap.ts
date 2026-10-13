import type { FastifyBaseLogger } from 'fastify';
import type { SsoNcsMapping } from '@dpg/config';
import { getDomainItemSchema, validateAgainstJsonSchema } from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { getNetworkConfigById } from '@/network_configs';
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
  | 'network'
  | 'item_type'
  | 'role_to_domain'
  | 'fields'
  | 'joined_fields'
  | 'value_maps'
  | 'age_from_dob'
>;

type FieldMapping = Pick<SsoProfileMapping, 'fields'> &
  Partial<Pick<SsoProfileMapping, 'joined_fields' | 'value_maps' | 'age_from_dob'>>;

/** The partner's phone field is stored in its normalised E.164 form. */
const PHONE_SOURCE_FIELDS = new Set(['mobileNumber']);

function sourceValue(identity: SsoIdentity, source: string): unknown {
  return PHONE_SOURCE_FIELDS.has(source) ? identity.phone : identity.attributes[source];
}

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

/** The partner's code translated through `value_maps`; undefined when unmapped. */
function mapValue(map: Record<string, string>, value: unknown): string | undefined {
  const key = String(value);
  if (Object.hasOwn(map, key)) return map[key];
  const lower = key.trim().toLowerCase();
  const hit = Object.keys(map).find((k) => k.trim().toLowerCase() === lower);
  return hit === undefined ? undefined : map[hit];
}

/** Whole years between an ISO `YYYY-MM-DD` date and `today`; null if unparseable. */
export function ageOn(dob: unknown, today: Date): number | null {
  const m = typeof dob === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(dob.trim()) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const born = new Date(Date.UTC(y, mo - 1, d));
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== mo - 1 || born.getUTCDate() !== d) {
    return null;
  }
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() + 1 < mo || (today.getUTCMonth() + 1 === mo && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

export function mapFields(
  identity: SsoIdentity,
  mapping: FieldMapping,
  today: Date = new Date()
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [source, target] of Object.entries(mapping.fields)) {
    let value = sourceValue(identity, source);
    if (isBlank(value)) continue;
    const valueMap = mapping.value_maps?.[source];
    if (valueMap) {
      value = mapValue(valueMap, value);
      if (value === undefined) continue;
    }
    payload[target] = value;
  }
  for (const [target, source] of Object.entries(mapping.age_from_dob ?? {})) {
    const age = ageOn(sourceValue(identity, source), today);
    if (age !== null) payload[target] = age;
  }
  for (const [target, sources] of Object.entries(mapping.joined_fields ?? {})) {
    const parts = sources
      .map((source) => sourceValue(identity, source))
      .filter((value) => !isBlank(value))
      .map((value) => String(value).trim())
      .filter(Boolean);
    if (parts.length > 0) payload[target] = parts.join(', ');
  }
  return payload;
}

/**
 * Drop each mapped value its own schema property rejects (an out-of-range age,
 * an unknown enum value, a wrong type), so one bad partner field cannot fail
 * the whole draft create. Logs field names only — the values are PII.
 */
export function keepValidFields(
  payload: Record<string, unknown>,
  itemSchema: Record<string, unknown>,
  log: FastifyBaseLogger
): Record<string, unknown> {
  const properties = (itemSchema.properties ?? {}) as Record<string, unknown>;
  const defs = {
    ...(itemSchema.$defs ? { $defs: itemSchema.$defs } : {}),
    ...(itemSchema.definitions ? { definitions: itemSchema.definitions } : {}),
  };
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [field, value] of Object.entries(payload)) {
    const property = properties[field];
    if (!property) {
      dropped.push(field);
      continue;
    }
    try {
      validateAgainstJsonSchema(
        { type: 'object', properties: { [field]: property }, ...defs },
        { [field]: value },
        field
      );
      kept[field] = value;
    } catch {
      dropped.push(field);
    }
  }
  if (dropped.length > 0) {
    log.warn({ dropped }, 'sso: partner fields the profile schema rejected were left out');
  }
  return kept;
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
    const itemSchema = getDomainItemSchema(
      await getNetworkConfigById(network),
      domain,
      mapping.item_type
    ) as Record<string, unknown>;
    const payload = keepValidFields(mapFields(identity, mapping), itemSchema, log);

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
        payload,
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
