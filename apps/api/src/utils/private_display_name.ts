/**
 * Read-time private display names for aggregator reads
 * (GET /aggregator/dashboard, GET /aggregator/export).
 *
 * `item_metrics.display_name` is computed from the masked public state, so an
 * item whose display field is `private: true` shows a mask or its item_id.
 * Only those items are fetched and decrypted here; public display fields
 * already have the right precomputed name.
 *
 * Never fails the read: every failure (config, lookup, missing key, corrupt
 * blob) keeps the precomputed name and logs one PII-free warning, so a missing
 * SIGNALS_PII_KEY is diagnosable.
 */

import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { and, eq, inArray } from 'drizzle-orm';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { getNetworkConfigById } from '@/network_configs';
import { resolveNameFallbackField, type DomainConfigForName } from '@/utils/contact_fields';

/** Minimal pino-compatible surface (`request.log`) for PII-free warnings. */
export interface NameResolutionLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** PII-free error identifier (PiiCryptoError.code or name). */
function errorType(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : err.name;
  }
  return 'unknown';
}

/**
 * Returns `item_id → decrypted display name` for rows whose display field
 * (`display_name_field`, else `card.title_field`) is `private: true`. One
 * items query per network/domain group. A missing key means "keep the
 * precomputed name".
 */
export async function resolve_private_display_names(
  rows: Array<{ itemId: string; itemNetwork: string; itemDomain: string; itemType: string }>,
  log?: NameResolutionLog,
): Promise<Map<string, string>> {
  // Keyed by item_id alone: it is a gen_random_uuid(), unique across partitions.
  const out = new Map<string, string>();
  if (rows.length === 0) return out;

  // Network/domain pins the items partition and the schema set.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.itemNetwork} ${r.itemDomain}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  for (const group of groups.values()) {
    const { itemNetwork: network, itemDomain: domain } = group[0];

    let private_fields: Record<string, string>;
    try {
      const cfg = await getNetworkConfigById(network);
      const domainCfg = cfg.domains.find((d) => d.id === domain);
      private_fields = Object.fromEntries(
        Object.entries(domainCfg?.item_schemas ?? {}).flatMap(([type, doc]) => {
          const field = resolveNameFallbackField(domainCfg as DomainConfigForName | undefined, type);
          if (field === undefined) return [];
          const schema = doc as { properties?: Record<string, { private?: unknown } | undefined> };
          if (schema.properties?.[field]?.private !== true) return [];
          return [[type, field]];
        }),
      );
    } catch (err) {
      log?.warn(
        {
          operation: 'resolve_private_display_names',
          status: 'skipped',
          error_type: errorType(err),
          network,
          domain,
          row_count: group.length,
        },
        'network config unavailable — keeping precomputed display names',
      );
      continue;
    }
    if (Object.keys(private_fields).length === 0) continue;

    try {
      const item_rows = await db
        .select({
          item_id: items.item_id,
          item_type: items.item_type,
          item_state: items.item_state,
          item_private_state: items.item_private_state,
        })
        .from(items)
        .where(
          and(
            eq(items.item_network, network),
            eq(items.item_domain, domain),
            inArray(
              items.item_id,
              group.map((r) => r.itemId),
            ),
          ),
        );

      let decrypt_failures = 0;
      let first_error: string | undefined;
      for (const r of item_rows) {
        const field = private_fields[r.item_type];
        if (!field) continue;
        // No private blob: the merged state would only hold the masked value.
        if (!r.item_private_state) continue;
        try {
          const { mergedState } = decryptItemPrivate({
            item_state: (r.item_state ?? {}) as Record<string, unknown>,
            item_private_state: r.item_private_state,
          });
          const name = mergedState[field];
          if (typeof name === 'string' && name.trim().length > 0) {
            out.set(r.item_id, name.trim());
          }
        } catch (err) {
          decrypt_failures += 1;
          first_error ??= errorType(err);
        }
      }
      if (decrypt_failures > 0) {
        log?.warn(
          {
            operation: 'resolve_private_display_names',
            status: 'skipped',
            error_type: first_error,
            network,
            domain,
            failed_rows: decrypt_failures,
          },
          'private-state decryption failed — keeping precomputed display names',
        );
      }
    } catch (err) {
      // A lookup error degrades this group to precomputed names rather than
      // failing the dashboard or truncating the export.
      log?.warn(
        {
          operation: 'resolve_private_display_names',
          status: 'skipped',
          error_type: errorType(err),
          network,
          domain,
          row_count: group.length,
        },
        'items lookup failed — keeping precomputed display names',
      );
      continue;
    }
  }
  return out;
}
