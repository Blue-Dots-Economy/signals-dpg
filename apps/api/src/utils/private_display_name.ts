/**
 * Read-time private display-name resolution for aggregator-scoped reads
 * (GET /aggregator/dashboard, GET /aggregator/export).
 *
 * The precomputed `item_metrics.display_name` only ever sees the masked
 * public state, so items whose display field is `private: true` (e.g.
 * purple_dot seeker `beneficiary_name`) surface as a mask or item_id.
 * This helper decrypts those — and ONLY those — at read time. Items whose
 * display field is public (e.g. provider `organisation_name`) are skipped
 * entirely: their precomputed name is already correct, and skipping them
 * avoids a redundant `items` fetch + decrypt per page.
 *
 * Failure contract: name resolution must never fail the read. Every
 * failure class (unknown network config, items lookup error, missing key,
 * corrupt blob) degrades to the precomputed name for the affected rows and
 * emits one PII-free structured warning so a misconfigured environment
 * (e.g. absent SIGNALS_PII_KEY) is diagnosable instead of silently
 * reproducing the masked-name bug.
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

/** Extracts a loggable, PII-free error identifier (PiiCryptoError.code or name). */
function errorType(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : err.name;
  }
  return 'unknown';
}

/**
 * Resolves real display names for metric rows whose schema declares a
 * `private: true` display field.
 *
 * Per item type the display field is the schema's `display_name_field`,
 * else the domain's `card.title_field` (the existing UI hint for "the
 * field that titles this item"). Types whose resolved field is not
 * `private: true` are excluded — the precomputed name already covers them.
 *
 * Reads the page's item rows in one query per network/domain group,
 * decrypts each non-empty `item_private_state` blob, and returns
 * `item_id → name` for rows where the merged state carries a non-empty
 * string at the display field. Everything else falls back to the
 * precomputed name.
 *
 * @param rows - The page's metric rows (already scoped to the acting aggregator).
 * @param log - Optional request logger for PII-free failure warnings.
 * @returns Map of item_id to decrypted display name; missing keys mean "keep precomputed".
 */
export async function resolve_private_display_names(
  rows: Array<{ itemId: string; itemNetwork: string; itemDomain: string; itemType: string }>,
  log?: NameResolutionLog,
): Promise<Map<string, string>> {
  // Keyed by item_id alone: the items PK is composite
  // (network, domain, type, item_id), but item_id is gen_random_uuid() —
  // globally unique across partitions.
  const out = new Map<string, string>();
  if (rows.length === 0) return out;

  // Group by network/domain — both pin the items partition and select the
  // right schema set.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.itemNetwork} ${r.itemDomain}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  for (const group of groups.values()) {
    const { itemNetwork: network, itemDomain: domain } = group[0];

    // Per item type: the display field that needs read-time decryption.
    // Only schema fields marked `private: true` qualify — a public display
    // field (provider organisation_name) is already correct in item_metrics.
    let private_fields: Record<string, string>;
    try {
      const cfg = await getNetworkConfigById(network);
      const domainCfg = cfg.domains.find((d) => d.id === domain);
      private_fields = Object.fromEntries(
        Object.entries(domainCfg?.item_schemas ?? {}).flatMap(([type, doc]) => {
          // Shared display-name precedence (display_name_field -> card.title_field).
          const field = resolveNameFallbackField(domainCfg as DomainConfigForName | undefined, type);
          if (field === undefined) return [];
          // Only schema fields marked `private: true` need read-time decryption.
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
        // No private blob → the merged state would surface the masked
        // public value (e.g. "R***"); keep the precomputed name instead.
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
      // Documented guarantee: name resolution never fails the read — a
      // transient items-lookup error degrades this group to precomputed
      // names instead of 500ing the dashboard or truncating the export.
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
