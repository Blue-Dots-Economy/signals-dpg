import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// `drizzle-orm` is mocked with tiny structural stand-ins so the WHERE / ORDER BY
// trees this module builds can be rendered back to text and asserted on without
// a live Postgres (the real coverage of these builders otherwise lives only in
// *.integration.test.ts, which the default vitest run excludes).
const { dbState, queries, getNetworkConfigById, decryptItemPrivate } = vi.hoisted(
  () => ({
    // `failWith` is a resettable flag (cleared in beforeEach) rather than a
    // monkey-patch of the shared result state, so a failure never leaks.
    dbState: {
      count: 0 as number | string,
      rows: [] as Record<string, unknown>[],
      failWith: null as Error | null,
    },
    queries: [] as Array<{
      cols: unknown;
      where: unknown;
      orderBy?: unknown;
      limit?: number;
      offset?: number;
    }>,
    getNetworkConfigById: vi.fn(),
    decryptItemPrivate: vi.fn(),
  })
);

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sql: true,
    strings: [...strings],
    values,
  });
  sql.join = (parts: unknown[], sep: unknown) => ({ __join: true, parts, sep });
  sql.raw = (text: string) => ({ __raw: text });
  return {
    sql,
    eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
    ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
    and: (...conds: unknown[]) => ({ op: 'and', conds }),
  };
});

vi.mock('@dpg/database', () => ({
  items: Object.fromEntries(
    [
      'item_network',
      'item_domain',
      'item_type',
      'item_id',
      'item_instance_url',
      'item_schema_url',
      'item_state',
      'item_private_state',
      'item_locations',
      'created_by',
      'created_at',
      'updated_at',
      'lifecycle_status',
    ].map((name) => [name, { __col: `items.${name}` }])
  ),
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: (cols: unknown) => ({
      from: () => ({
        where: (where: unknown) => {
          const q: (typeof queries)[number] = { cols, where };
          queries.push(q);
          const settleCount = () =>
            dbState.failWith
              ? Promise.reject(dbState.failWith)
              : Promise.resolve([{ count: dbState.count }]);
          return {
            // countLocalItems awaits `.where(...)` directly. BOTH callbacks
            // must be forwarded or a rejected query hangs the await.
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              settleCount().then(res, rej),
            orderBy: (orderBy: unknown) => {
              q.orderBy = orderBy;
              return {
                limit: (limit: number) => {
                  q.limit = limit;
                  return {
                    offset: (offset: number) => {
                      q.offset = offset;
                      return dbState.failWith
                        ? Promise.reject(dbState.failWith)
                        : Promise.resolve(dbState.rows);
                    },
                  };
                },
              };
            },
          };
        },
      }),
    }),
  },
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: unknown[]) => getNetworkConfigById(...a),
}));

vi.mock('../item_decrypt', () => ({
  decryptItemPrivate: (...a: unknown[]) => decryptItemPrivate(...a),
}));

import {
  countLocalItems,
  fetchLocalItems,
  fetchLocalMarkers,
  type ItemFetchFilters,
} from '../item_fetch_runtime';

// --- helpers ---------------------------------------------------------------

/** Renders a mocked condition tree to comparable text. */
function render(node: unknown): string {
  if (node === null || node === undefined) return String(node);
  if (typeof node === 'object') {
    const n = node as Record<string, unknown>;
    if (typeof n.__raw === 'string') return n.__raw;
    if (typeof n.__col === 'string') return n.__col;
    if (n.__join) return (n.parts as unknown[]).map(render).join(render(n.sep));
    if (n.__sql) {
      const strings = n.strings as string[];
      const values = n.values as unknown[];
      return strings
        .map((s, i) => s + (i < values.length ? render(values[i]) : ''))
        .join('');
    }
    if (n.op === 'eq' || n.op === 'ne') {
      return `${render(n.col)} ${n.op as string} ${render(n.val)}`;
    }
    if (n.op === 'and') return (n.conds as unknown[]).map(render).join(' AND ');
  }
  if (typeof node === 'string') return `'${node}'`;
  return String(node);
}

/** Collapses whitespace so multi-line sql templates are easy to assert on. */
function whereText(index = 0): string {
  return render(queries[index]?.where).replace(/\s+/g, ' ').trim();
}

function conditions(index = 0): unknown[] {
  return (queries[index]?.where as { conds: unknown[] }).conds;
}

const base: Omit<ItemFetchFilters, 'limit' | 'offset'> = {
  item_network: 'blue_dot',
  item_domain: 'student',
};

const page = { limit: 10, offset: 20 };

const log = { debug: vi.fn() };

/** A network config declaring one public and one private field. */
function networkConfig() {
  return {
    domains: [
      {
        id: 'student',
        item_schemas: {
          'profile_1.0': {
            properties: {
              college: { type: 'string' },
              phone: { type: 'string', private: true },
              city: { type: 'string' },
              broken: 'not-an-object',
            },
          },
          'post_1.0': { properties: { topic: { type: 'string' } } },
          no_props: {},
        },
      },
    ],
  };
}

beforeEach(() => {
  queries.length = 0;
  dbState.count = 0;
  dbState.rows = [];
  dbState.failWith = null;
  vi.clearAllMocks();
  getNetworkConfigById.mockResolvedValue(networkConfig());
  decryptItemPrivate.mockReturnValue({ mergedState: { merged: true } });
});

// --- partition-pruning contract -------------------------------------------

describe('buildWhereClause partition pruning', () => {
  it('always filters on item_network + item_domain, even with no other filters', async () => {
    await countLocalItems(base);

    expect(conditions()).toHaveLength(2);
    expect(whereText()).toBe(
      "items.item_network eq 'blue_dot' AND items.item_domain eq 'student'"
    );
  });

  it('keeps the partition keys alongside every optional equality filter', async () => {
    await countLocalItems({
      ...base,
      item_id: 'i1',
      item_type: 'profile_1.0',
      created_by: 'u1',
      item_instance_url: 'https://a/item/i1',
      item_schema_url: 'https://a/schema',
    });

    const text = whereText();
    expect(text).toContain("items.item_network eq 'blue_dot'");
    expect(text).toContain("items.item_domain eq 'student'");
    expect(text).toContain("items.item_id eq 'i1'");
    expect(text).toContain("items.item_type eq 'profile_1.0'");
    expect(text).toContain("items.created_by eq 'u1'");
    expect(text).toContain("items.item_instance_url eq 'https://a/item/i1'");
    expect(text).toContain("items.item_schema_url eq 'https://a/schema'");
  });

  it('drops null instance/schema url filters instead of matching NULL', async () => {
    await countLocalItems({
      ...base,
      item_instance_url: null,
      item_schema_url: null,
    });

    expect(conditions()).toHaveLength(2);
  });
});

// --- lifecycle ------------------------------------------------------------

describe('lifecycle filters', () => {
  it('excludes retired items only when exclude_retired is set (#347)', async () => {
    await countLocalItems({ ...base, exclude_retired: true });
    expect(whereText()).toContain("items.lifecycle_status ne 'retired'");

    queries.length = 0;
    await countLocalItems(base);
    expect(whereText()).not.toContain('lifecycle_status');
  });

  it("restricts to live for lifecycle_filter='live_only' and not for 'all'", async () => {
    await countLocalItems({ ...base, lifecycle_filter: 'live_only' });
    expect(whereText()).toContain("items.lifecycle_status eq 'live'");

    queries.length = 0;
    await countLocalItems({ ...base, lifecycle_filter: 'all' });
    expect(whereText()).not.toContain('lifecycle_status');
  });
});

// --- item_state facet guard (#394) ---------------------------------------

describe('item_state facet guard', () => {
  it('applies an allowed array facet as a guarded = ANY match', async () => {
    await countLocalItems({
      ...base,
      item_state: { college: ['Alpha', 'Beta'] },
    });

    expect(whereText()).toContain(
      "items.item_state ->> 'college' = ANY(ARRAY['Alpha', 'Beta'])"
    );
  });

  it('normalizes a scalar facet to a single-element = ANY (no unguarded containment branch)', async () => {
    await countLocalItems({ ...base, item_state: { college: 'Alpha' } });

    const text = whereText();
    expect(text).toContain("items.item_state ->> 'college' = ANY(ARRAY['Alpha'])");
    expect(text).not.toContain('@>');
  });

  it('drops a private field silently and logs the drop', async () => {
    await countLocalItems(
      { ...base, item_state: { phone: '99900011', city: 'Pune' } },
      log
    );

    const text = whereText();
    expect(text).not.toContain('phone');
    expect(text).toContain("items.item_state ->> 'city' = ANY(ARRAY['Pune'])");
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      { item_network: 'blue_dot', item_domain: 'student', field: 'phone' },
      'Dropping item_state facet filter: field is not declared and non-private for this domain'
    );
  });

  it('drops an undeclared field so it cannot be enumerated', async () => {
    await countLocalItems({ ...base, item_state: { secret_flag: 'x' } });

    expect(conditions()).toHaveLength(2);
  });

  it('allows fields declared on any item_type of the domain', async () => {
    await countLocalItems({ ...base, item_state: { topic: 'jobs' } });

    expect(whereText()).toContain("items.item_state ->> 'topic' = ANY(ARRAY['jobs'])");
  });

  it('makes an explicit empty value set match nothing', async () => {
    await countLocalItems({ ...base, item_state: { college: [] } });

    expect(whereText()).toContain('false');
  });

  it('fails closed when the domain is not configured', async () => {
    await countLocalItems({
      ...base,
      item_domain: 'unknown_domain',
      item_state: { college: 'Alpha' },
    });

    expect(conditions()).toHaveLength(2);
  });

  it('fails closed when the network config load throws', async () => {
    getNetworkConfigById.mockRejectedValue(new Error('config down'));

    await countLocalItems({ ...base, item_state: { college: 'Alpha' } });

    expect(conditions()).toHaveLength(2);
  });

  it('does not resolve the allowlist for an empty item_state object', async () => {
    await countLocalItems({ ...base, item_state: {} });

    expect(getNetworkConfigById).not.toHaveBeenCalled();
    expect(conditions()).toHaveLength(2);
  });
});

// --- free-text search (#394) ---------------------------------------------

describe('text_search', () => {
  it('matches only the server-resolved fields via jsonb_each_text ILIKE', async () => {
    await countLocalItems({
      ...base,
      text_search: { q: 'delhi', fields: ['city', 'college'] },
    });

    const text = whereText();
    expect(text).toContain('EXISTS ( SELECT 1 FROM jsonb_each_text(items.item_state) e');
    expect(text).toContain("e.key = ANY(ARRAY['city', 'college'])");
    expect(text).toContain("e.value ILIKE '%delhi%' ESCAPE '\\'");
  });

  it('escapes LIKE metacharacters so q cannot inject wildcards', async () => {
    await countLocalItems({
      ...base,
      text_search: { q: 'a%b_c\\d', fields: ['city'] },
    });

    expect(whereText()).toContain("ILIKE '%a\\%b\\_c\\\\d%'");
  });

  it('is unsatisfiable when no non-private field is available', async () => {
    await countLocalItems({ ...base, text_search: { q: 'delhi', fields: [] } });

    const text = whereText();
    expect(text).toContain('false');
    expect(text).not.toContain('ILIKE');
  });
});

// --- geo ------------------------------------------------------------------

describe('geo refinement', () => {
  it('builds a per-location earth_box + earth_distance radius match', async () => {
    await countLocalItems({
      ...base,
      item_latitude: 12.9,
      item_longitude: 77.6,
      radius_meters: 5000,
    });

    const text = whereText();
    expect(text).toContain('jsonb_array_elements(items.item_locations) loc');
    expect(text).toContain('earth_box(ll_to_earth(12.9, 77.6), 5000)');
    expect(text).toContain('<= 5000');
  });

  it('ignores an incomplete radius triple', async () => {
    await countLocalItems({ ...base, item_latitude: 12.9, item_longitude: 77.6 });

    expect(conditions()).toHaveLength(2);
  });

  it('prefers the radius branch over a bbox when both are supplied', async () => {
    await countLocalItems({
      ...base,
      item_latitude: 12.9,
      item_longitude: 77.6,
      radius_meters: 1000,
      min_lat: 1,
      min_lng: 2,
      max_lat: 3,
      max_lng: 4,
    });

    const text = whereText();
    expect(text).toContain('earth_box');
    expect(text).not.toContain('ST_MakeEnvelope');
  });

  it('joins the GiST-indexed item_search geo with an exact ST_Intersects recheck', async () => {
    await countLocalItems({
      ...base,
      min_lat: 12,
      min_lng: 77,
      max_lat: 13,
      max_lng: 78,
    });

    const text = whereText();
    expect(text).toContain('FROM item_search s');
    expect(text).toContain(
      's.item_network = items.item_network AND s.item_id = items.item_id'
    );
    expect(text).toContain("s.lifecycle_status = 'live'");
    expect(text).toContain(
      's.geo && ST_MakeEnvelope(77, 12, 78, 13, 4326)::geography'
    );
    expect(text).toContain(
      'ST_Intersects(s.geo, ST_MakeEnvelope(77, 12, 78, 13, 4326)::geography)'
    );
  });

  it('returns nothing for an inverted/degenerate bbox instead of erroring', async () => {
    await countLocalItems({
      ...base,
      min_lat: 13,
      min_lng: 77,
      max_lat: 12,
      max_lng: 78,
    });

    let text = whereText();
    expect(text).toContain('false');
    expect(text).not.toContain('ST_MakeEnvelope');

    queries.length = 0;
    await countLocalItems({
      ...base,
      min_lat: 12,
      min_lng: 77,
      max_lat: 13,
      max_lng: 77,
    });
    text = whereText();
    expect(text).toContain('false');
    expect(text).not.toContain('ST_MakeEnvelope');
  });
});

// --- countLocalItems ------------------------------------------------------

describe('countLocalItems', () => {
  it('coerces the pg bigint count string to a number', async () => {
    dbState.count = '42';

    await expect(countLocalItems(base)).resolves.toBe(42);
  });

  it('propagates a db failure to the caller', async () => {
    dbState.failWith = new Error('db down');

    await expect(countLocalItems(base)).rejects.toThrow('db down');
  });
});

// --- fetchLocalItems ------------------------------------------------------

describe('fetchLocalItems', () => {
  const row = {
    item_id: 'i1',
    item_state: { a: 1 },
    item_private_state: 'cipher',
    lifecycle_status: 'live',
  };

  it('returns paging meta and strips item_private_state by default', async () => {
    dbState.count = 3;
    dbState.rows = [{ ...row }];

    const result = await fetchLocalItems({ ...base, ...page });

    expect(result.meta).toEqual({ total: 3, limit: 10, offset: 20 });
    expect(result.items).toEqual([
      { item_id: 'i1', item_state: { a: 1 }, lifecycle_status: 'live' },
    ]);
    expect(decryptItemPrivate).not.toHaveBeenCalled();
    expect(queries[1]?.limit).toBe(10);
    expect(queries[1]?.offset).toBe(20);
  });

  it('merges the decrypted private blob when includePrivateState is true', async () => {
    dbState.rows = [{ ...row }];

    const result = await fetchLocalItems({
      ...base,
      ...page,
      includePrivateState: true,
    });

    expect(decryptItemPrivate).toHaveBeenCalledWith({
      item_state: { a: 1 },
      item_private_state: 'cipher',
    });
    expect(result.items).toEqual([
      { item_id: 'i1', item_state: { merged: true }, lifecycle_status: 'live' },
    ]);
  });

  it('passes an empty string when there is no stored private blob', async () => {
    dbState.rows = [{ ...row, item_private_state: null }];

    await fetchLocalItems({ ...base, ...page, includePrivateState: true });

    expect(decryptItemPrivate).toHaveBeenCalledWith({
      item_state: { a: 1 },
      item_private_state: '',
    });
  });

  it('orders live first then created_at DESC when no center is given', async () => {
    await fetchLocalItems({ ...base, ...page });

    const order = render(queries[1]?.orderBy).replace(/\s+/g, ' ').trim();
    expect(order).toBe(
      "(items.lifecycle_status = 'live') DESC, items.created_at DESC"
    );
  });

  it('orders nearest-first (no-location rows last) when a center is given', async () => {
    await fetchLocalItems({
      ...base,
      ...page,
      item_latitude: 12.9,
      item_longitude: 77.6,
    });

    const order = render(queries[1]?.orderBy).replace(/\s+/g, ' ').trim();
    expect(order).toContain("(items.lifecycle_status = 'live') DESC");
    expect(order).toContain('SELECT MIN( earth_distance( ll_to_earth(12.9, 77.6)');
    expect(order).toContain('ASC NULLS LAST');
    expect(order).toContain('items.created_at DESC');
  });

  it('uses the same WHERE clause for the count and the page query', async () => {
    await fetchLocalItems({ ...base, ...page, lifecycle_filter: 'live_only' });

    expect(queries).toHaveLength(2);
    expect(whereText(0)).toBe(whereText(1));
    expect(whereText(1)).toContain("items.lifecycle_status eq 'live'");
  });
});

// --- fetchLocalMarkers ----------------------------------------------------

describe('fetchLocalMarkers', () => {
  it('selects only the slim marker projection', async () => {
    dbState.count = 2;
    dbState.rows = [{ item_id: 'i1', item_locations: [] }];

    const result = await fetchLocalMarkers({ ...base, ...page });

    expect(result.meta).toEqual({ total: 2, limit: 10, offset: 20 });
    expect(result.markers).toEqual([{ item_id: 'i1', item_locations: [] }]);
    expect(Object.keys(queries[1]?.cols as Record<string, unknown>)).toEqual([
      'item_id',
      'item_domain',
      'item_instance_url',
      'item_locations',
    ]);
  });

  it('orders by distance/created_at without the live-first key', async () => {
    await fetchLocalMarkers({ ...base, ...page });

    const order = render(queries[1]?.orderBy).replace(/\s+/g, ' ').trim();
    expect(order).toBe('items.created_at DESC');
  });

  it('shares the filter builder with the list feed (partition keys + facets)', async () => {
    await fetchLocalMarkers({
      ...base,
      ...page,
      item_state: { college: 'Alpha' },
      lifecycle_filter: 'live_only',
    });

    const text = whereText(1);
    expect(text).toContain("items.item_network eq 'blue_dot'");
    expect(text).toContain("items.item_domain eq 'student'");
    expect(text).toContain("items.item_state ->> 'college' = ANY(ARRAY['Alpha'])");
    expect(text).toContain("items.lifecycle_status eq 'live'");
  });
});
