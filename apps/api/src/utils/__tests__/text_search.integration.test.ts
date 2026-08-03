/**
 * #394 (map native text search) — integration test for the free-text
 * value-match search on markers: `buildWhereClause`'s `text_search` branch
 * (item_fetch_runtime.ts), exercised through `fetchLocalMarkers`.
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * Security-critical bit under test: the match only ever looks at the
 * SERVER-resolved, non-private `item_state` field keys (`fields`, exactly
 * what `markers.ts`'s `resolveTextSearchFields` would compute via
 * `resolveAllowedFacetFields` from facet_guard.ts) — never a client-supplied
 * field list, and never a `private: true` field's value, even when this
 * suite deliberately plants the search term as the ONLY occurrence in a
 * private field's item_state value (defense-in-depth: item_state never
 * actually carries private values in production, but the SQL guard itself
 * must not depend on that).
 *
 * Uses `resolveBindings()` (the same helper other `apps/api` integration
 * suites use) so this runs against whatever network/domain is actually
 * served, reading that domain's real JSON-schema `properties` to find a
 * genuine non-private string field and a genuine `private: true` field
 * rather than a fabricated schema. `item_search` rows are seeded directly
 * (Option B bbox join target — see item_fetch_runtime.integration.test.ts's
 * header comment for why), same construction as that suite. Seeds a
 * dedicated `item_type` probe string + owner so this suite never collides
 * with other data in the same partition; cleans up in afterAll. Skips when
 * POSTGRES_URL / POSTGRES_USER is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@api/db/postgres/drizzle_config';
import { items, ensureItemPartition } from '@dpg/database';
import { user } from '@api/db/postgres/schema';
import { resolveBindings } from '../../routes/v1/__tests__/integration_helpers';
import { fetchLocalMarkers } from '../item_fetch_runtime';
import { resolveAllowedFacetFields } from '../facet_guard';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;

// bbox under test — same construction as the other item_fetch_runtime bbox
// suite: 1° latitude/longitude offsets give predictable in/out placement.
const MIN_LAT = 8.9;
const MIN_LNG = 40.9;
const MAX_LAT = 9.1;
const MAX_LNG = 41.1;
const inBox = { lat: 9.0, lng: 41.0 };
const outOfBox = { lat: 30.0, lng: 60.0 };

// Distinctive tokens unlikely to collide with any real/other-suite data.
const MATCH = 'zzzquokkaviewport394';
const PRIVATE_MATCH = 'zzzquokkaprivate394';

function findNonPrivateStringField(schema: Record<string, unknown>): string {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) throw new Error('resolved binding schema has no properties');
  const entry = Object.entries(properties).find(
    ([, def]) => def.private !== true && def.type === 'string'
  );
  if (!entry) {
    throw new Error('no non-private string field found on the resolved binding');
  }
  return entry[0];
}

function findPrivateField(schema: Record<string, unknown>): string {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) throw new Error('resolved binding schema has no properties');
  const entry = Object.entries(properties).find(([, def]) => def.private === true);
  if (!entry) throw new Error('no private field found on the resolved binding');
  return entry[0];
}

describeIf(
  `text-search value-match on markers (#394)${can_run ? '' : ' — SKIPPED (no POSTGRES_URL)'}`,
  () => {
    let NET: string;
    let DOMAIN: string;
    const TYPE = `text_search_probe_${randomUUID().slice(0, 8)}`;
    const OWNER_ID = `text-search-suite-user-${randomUUID().slice(0, 8)}`;

    let publicField: string;
    let privateField: string;
    let allowedFields: string[];

    const ids: Record<string, string> = {};

    async function seedItem(
      key: string,
      loc: { lat: number; lng: number },
      itemState: Record<string, unknown>
    ): Promise<string> {
      const [row] = await db
        .insert(items)
        .values({
          item_network: NET,
          item_domain: DOMAIN,
          item_type: TYPE,
          item_instance_url: 'http://localhost:2742',
          item_schema_url: 'http://localhost:2742/schema',
          created_by: OWNER_ID,
          item_locations: [loc],
          item_state: itemState,
          lifecycle_status: 'live',
        })
        .returning({ item_id: items.item_id });
      ids[key] = row.item_id;
      return row.item_id;
    }

    // Mirrors item_fetch_runtime.integration.test.ts's bbox suite: item_search
    // is the Option B join target the bbox branch of buildWhereClause reads.
    async function seedItemSearch(
      itemId: string,
      loc: { lat: number; lng: number }
    ): Promise<void> {
      await db.execute(sql`
        INSERT INTO item_search (item_network, item_domain, item_type, item_id, geo, lifecycle_status)
        VALUES (
          ${NET}, ${DOMAIN}, ${TYPE}, ${itemId},
          ST_GeogFromText(${`MULTIPOINT(${loc.lng} ${loc.lat})`}),
          'live'
        )
      `);
    }

    beforeAll(async () => {
      const { primary } = await resolveBindings();
      NET = primary.network;
      DOMAIN = primary.domain;
      publicField = findNonPrivateStringField(primary.schema);
      privateField = findPrivateField(primary.schema);
      // Exactly what markers.ts's resolveTextSearchFields would compute for
      // this item_type — reused directly, not reimplemented, so this suite
      // proves the real allowlist a caller would get.
      allowedFields = [...resolveAllowedFacetFields(primary.schema).keys()];

      await ensureItemPartition(db, NET, DOMAIN);
      await db.insert(user).values({ id: OWNER_ID, name: 'Text Search Suite' });

      const pubAId = await seedItem('pubA', inBox, {
        [publicField]: `alpha ${MATCH} beta`,
      });
      const pubBId = await seedItem('pubB', inBox, {
        [publicField]: `gamma ${MATCH} delta`,
      });
      const pubOutId = await seedItem('pubOut', outOfBox, {
        [publicField]: `epsilon ${MATCH} zeta`,
      });
      const noMatchId = await seedItem('noMatch', inBox, {
        [publicField]: 'nothing related in here',
      });
      const privateOnlyId = await seedItem('privateOnly', inBox, {
        [privateField]: `only in private ${PRIVATE_MATCH}`,
      });
      const literalPercentId = await seedItem('literalPercent', inBox, {
        [publicField]: 'weird a%b value',
      });
      const noPercentId = await seedItem('noPercent', inBox, {
        [publicField]: 'a100b value, no percent at all',
      });

      await seedItemSearch(pubAId, inBox);
      await seedItemSearch(pubBId, inBox);
      await seedItemSearch(pubOutId, outOfBox);
      await seedItemSearch(noMatchId, inBox);
      await seedItemSearch(privateOnlyId, inBox);
      await seedItemSearch(literalPercentId, inBox);
      await seedItemSearch(noPercentId, inBox);
    });

    afterAll(async () => {
      await db
        .delete(items)
        .where(and(eq(items.item_network, NET), eq(items.item_type, TYPE)));
      await db.execute(
        sql`DELETE FROM item_search WHERE item_network = ${NET} AND item_type = ${TYPE}`
      );
      await db.delete(user).where(eq(user.id, OWNER_ID));
    });

    function baseFilters() {
      return {
        item_network: NET,
        item_domain: DOMAIN,
        item_type: TYPE,
        limit: 100,
        offset: 0,
        lifecycle_filter: 'live_only' as const,
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
      };
    }

    it('the resolved allowlist includes the public field and excludes the private one (sanity check on the fixture itself)', () => {
      expect(allowedFields).toContain(publicField);
      expect(allowedFields).not.toContain(privateField);
    });

    it('(a)+(c) matches a public field value within the bbox, excludes an out-of-bbox match and a non-matching in-bbox item', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        text_search: { q: MATCH, fields: allowedFields },
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.pubA)).toBe(true);
      expect(got.has(ids.pubB)).toBe(true);
      expect(got.has(ids.pubOut)).toBe(false); // matches text, but outside the viewport
      expect(got.has(ids.noMatch)).toBe(false); // in viewport, but text doesn't match
      expect(got.has(ids.privateOnly)).toBe(false); // no MATCH token anywhere public
      expect(res.markers.length).toBe(2);
      expect(res.meta.total).toBe(2);
    });

    it('(b) a private field is the ONLY occurrence of the query text — 0 results (security guard, not just "no match")', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        text_search: { q: PRIVATE_MATCH, fields: allowedFields },
      });

      expect(res.markers).toEqual([]);
      expect(res.meta.total).toBe(0);
    });

    it('(d) meta.total reflects the full filtered count even when limit truncates the page', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        limit: 1,
        text_search: { q: MATCH, fields: allowedFields },
      });

      expect(res.markers.length).toBe(1);
      expect(res.meta.total).toBe(2);
      expect(res.meta.limit).toBe(1);
    });

    it('an empty fields allowlist (no non-private field declared) is unsatisfiable — 0 results, not "match everything"', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        text_search: { q: MATCH, fields: [] },
      });

      expect(res.markers).toEqual([]);
      expect(res.meta.total).toBe(0);
    });

    it('a literal "%" in q is escaped, not treated as a SQL LIKE wildcard', async () => {
      // If `%` were NOT escaped, searching for the literal pattern `a%b`
      // would match ANY value containing "a", then anything, then "b" —
      // including `noPercentId`'s "a100b value..." — a false positive that
      // would prove wildcard injection is possible via `q`.
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        text_search: { q: 'a%b', fields: allowedFields },
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.literalPercent)).toBe(true); // genuinely contains the literal "a%b"
      expect(got.has(ids.noPercent)).toBe(false); // must NOT false-positive via an unescaped wildcard
      expect(res.markers.length).toBe(1);
    });
  }
);
