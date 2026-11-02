import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization } from '@api/db/postgres/schema/auth';

/**
 * Reads an aggregator's declared item domains from `organization.metadata`, a
 * JSON string column that `POST /api/v1/admin/aggregator/upsert` writes
 * (`{ external_id, domains, ... }`).
 *
 * A null column, malformed JSON, a missing `domains` key or non-string entries
 * all degrade to `[]`; callers decide what an empty list means.
 */

function parseConfiguredDomains(metadata: string | null | undefined): string[] {
  if (!metadata) return [];
  try {
    const meta = JSON.parse(metadata) as { domains?: unknown };
    if (!Array.isArray(meta.domains)) return [];
    return meta.domains.filter((d): d is string => typeof d === 'string');
  } catch {
    return [];
  }
}

/**
 * The org's declared domains, or `[]` when the org is missing or its metadata
 * has no usable `domains` array.
 */
export async function readConfiguredDomains(orgId: string): Promise<string[]> {
  const [org] = (await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)) as Array<{ metadata: string | null }>;

  return parseConfiguredDomains(org?.metadata);
}
