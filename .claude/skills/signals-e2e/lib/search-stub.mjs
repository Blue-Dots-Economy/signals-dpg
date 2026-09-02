// signals-search stand-in for e2e runs.
//
// Read `apps/api/src/services/signals_search_client.ts` before touching this
// file: it documents the trap this stub exists to guard — an array-valued
// facet MUST map to `contains_any` (jsonb `?|` overlap), never `in`, however
// many values are selected, because `in` extracts the field as serialized-
// array TEXT via `item_state->>field` and so never matches a single scalar.
// `translateClause`/`classifyRequest`/`validationError` (imported below) are
// the SQL-building and request-classification logic this stub shares,
// bit-for-bit, with their own unit tests (e2e/src/__tests__/search.test.ts)
// — Node 24 strips TypeScript types by default (no --experimental-strip-types
// flag needed; confirmed), so this plain `.mjs` can import the `.ts` source
// directly instead of keeping a second, driftable copy of that logic in sync
// by hand.
//
// This is a STUB, not a reimplementation of signals-search's relevance
// engine: `textSearch` is a literal case-insensitive substring match, not a
// vector-embedding similarity search, and ranking is a deterministic
// `1 / (1 + rowIndex)` rather than real relevance scoring. Both are correct
// enough to prove the request/response CONTRACT (what the API asked for, and
// that a result set with an assertable order comes back) without an ONNX
// embedder this host can't run cheaply (see task-6-brief.md).
//
// Read-only against the DB: this stub only ever SELECTs from `item_search` /
// `items`. It has no business writing or deleting application rows.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// `pg` is an e2e/ dependency (Task 1), not a root one — this worktree has no
// root node_modules. Plain ESM `import` ignores NODE_PATH entirely (verified:
// `import pg from 'pg'` throws ERR_MODULE_NOT_FOUND even with NODE_PATH set),
// but `createRequire`'s CommonJS resolution algorithm DOES consult it, same
// as a plain `require()` would — so this script must be launched with
// `NODE_PATH=e2e/node_modules` (see task-6-brief.md Step 6).
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const here = dirname(fileURLToPath(import.meta.url));
const { translateClause, classifyRequest } = await import(resolve(here, '../../../../e2e/src/search.ts'));

// Mirrors signals-search's own default `s_dwithin` radius, per discover.ts's
// DEFAULT_SEARCH_DISTANCE_METERS comment: the DPG API deliberately omits
// `distance_meters` when it has no override, trusting signals-search's own
// default rather than hardcoding one client-side. This stub IS that default.
const DEFAULT_DISTANCE_METERS = 30000;

// A single shared scratch directory for any signals-e2e stub script under
// lib/ (this one, and Task 7's search-indexer.mjs) — see the root
// .gitignore entry. Reset on every process start so a stale run's rows can't
// leak into this one's assertions.
const SCRATCH_DIR = resolve(here, 'scratch');
mkdirSync(SCRATCH_DIR, { recursive: true });
const RECORD_PATH = resolve(SCRATCH_DIR, 'search-stub-requests.jsonl');
writeFileSync(RECORD_PATH, '');

let recorded = [];
let mode = 'ok';

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VALID_MODES = ['ok', 'down', 'slow', 'anchor-not-found'];

class ClauseError extends Error {}

/**
 * Builds the WHERE clause + params shared by the count and row queries.
 * Thrown errors here (an unsupported/unsafe op or target) are a malformed
 * REQUEST, not a query failure — kept as a distinct, synchronous step so the
 * caller can turn it into 400 INVALID_REQUEST rather than 500.
 */
function buildWhere(envelope) {
  const { context, message } = envelope;
  const { intent } = message;
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const whereParts = [
    `s.lifecycle_status = 'live'`,
    `i.item_network = ${bind(context.networkId)}`,
    `i.item_domain = ${bind(context.domain)}`,
    `i.item_type = ${bind(context.itemType)}`,
  ];

  for (const clause of intent.filters ?? []) {
    let translated;
    try {
      translated = translateClause(clause);
    } catch (err) {
      throw new ClauseError(err.message);
    }
    // translateClause always emits its bind value through a SINGLE literal
    // `$1` placeholder — asserted here, not assumed, because a naive
    // first-occurrence string .replace would silently mis-bind if that ever
    // stopped being true (e.g. a future op template that mentions "$1" more
    // than once). \b keeps "$1" from matching inside "$10"/"$11" if this
    // query ever has 10+ params by the time a clause is translated.
    const occurrences = translated.sql.match(/\$1\b/g) ?? [];
    if (occurrences.length !== 1) {
      throw new ClauseError(
        `translateClause produced ${occurrences.length} "$1" placeholders for target "${clause.target}" — expected exactly 1`,
      );
    }
    const placeholder = bind(translated.params[0]);
    whereParts.push(translated.sql.replace(/\$1\b/, placeholder));
  }

  if (intent.textSearch) {
    // item_state is already the masked PUBLIC projection — item_service.ts's
    // maskPrivateState strips every `private: true` field BEFORE the row is
    // ever written to `items` (confirmed live: a masked name reads "A***").
    // Scanning every top-level string value is therefore equivalent to
    // restricting the match to declared, non-private fields without a
    // second schema fetch to reproduce that guarantee here.
    const q = bind(`%${intent.textSearch}%`);
    whereParts.push(`EXISTS (SELECT 1 FROM jsonb_each_text(i.item_state) kv WHERE kv.value ILIKE ${q})`);
  }

  // `orderExpr` stays the raw SQL expression (never a SELECT-list output
  // alias): a window function's own ORDER BY can't forward-reference a
  // sibling alias computed in the same list (confirmed live — Postgres
  // 42703 "column distance does not exist"), since both are evaluated in the
  // same scope. The raw expression works in both the ROW_NUMBER() OVER (...)
  // clause and the outer ORDER BY, so reusing it everywhere sidesteps the
  // scoping question rather than working around it.
  //
  // `i.item_id` is a tiebreaker in both branches — Postgres gives no
  // ordering guarantee across ties on `updated_at` (or on floating-point
  // `ST_Distance`), and the whole point of the deterministic score is
  // assertable ordering; an unstable tie would undermine that silently.
  let orderExpr = 'updated_at DESC, i.item_id';
  let selectExtra = '';
  if (intent.spatial && intent.spatial.length > 0) {
    const [clause] = intent.spatial;
    const [lng, lat] = clause.geometry.coordinates;
    const point = `ST_SetSRID(ST_MakePoint(${bind(lng)}, ${bind(lat)}), 4326)::geography`;
    const distanceP = bind(clause.distanceMeters ?? DEFAULT_DISTANCE_METERS);
    const distanceSql = `ST_Distance(s.geo, ${point})`;
    whereParts.push(`ST_DWithin(s.geo, ${point}, ${distanceP})`);
    selectExtra = `, ${distanceSql} AS distance`;
    orderExpr = `${distanceSql}, i.item_id`;
  }

  return { whereSql: whereParts.join(' AND '), params, orderExpr, selectExtra, bind };
}

async function executeSearch(pool, pagination, query) {
  const { whereSql, params, orderExpr, selectExtra, bind } = query;
  const fromSql = `item_search s JOIN items i USING (item_network, item_domain, item_type, item_id) WHERE ${whereSql}`;

  const totalRes = await pool.query(`SELECT count(*)::int AS total FROM ${fromSql}`, params);
  const total = totalRes.rows[0]?.total ?? 0;

  const limitP = bind(pagination.limit);
  const offsetP = bind(pagination.offset);
  const rowsRes = await pool.query(
    `SELECT i.item_network, i.item_domain, i.item_type, i.item_id, i.item_state,
            i.item_locations, i.item_instance_url, i.item_schema_url,
            i.created_at, i.updated_at, i.created_by, i.lifecycle_status
            ${selectExtra},
            (ROW_NUMBER() OVER (ORDER BY ${orderExpr}) - 1)::int AS row_index
     FROM ${fromSql}
     ORDER BY ${orderExpr}
     LIMIT ${limitP} OFFSET ${offsetP}`,
    params,
  );

  const items = rowsRes.rows.map((row) => ({
    item_network: row.item_network,
    item_domain: row.item_domain,
    item_type: row.item_type,
    item_id: row.item_id,
    item_state: row.item_state,
    item_locations: row.item_locations,
    item_instance_url: row.item_instance_url,
    item_schema_url: row.item_schema_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    lifecycle_status: row.lifecycle_status,
    // Deterministic by construction — ranking order is assertable without
    // reproducing real relevance math.
    score: 1 / (1 + row.row_index),
    ...(row.distance !== undefined ? { distanceMeters: row.distance } : {}),
  }));

  return { items, meta: { total, limit: pagination.limit, offset: pagination.offset } };
}

function readBody(req) {
  return new Promise((res, rej) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => res(raw));
    req.on('error', rej);
  });
}

/**
 * Every request is recorded — accepted or not — so `rejectedEnvelopes()`
 * being empty is an assertable claim, not just `acceptedEnvelopes()` looking
 * right (see e2e/src/search.ts's RecordedRequest doc comment).
 */
function recordRequest(entry) {
  recorded.push(entry);
  appendFileSync(RECORD_PATH, `${JSON.stringify(entry)}\n`);
}

function makeServer(pool) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // The `_e2e` control surface always answers, regardless of `mode` — a run
    // stuck in `down`/`slow` must still be able to call setMode('ok') to
    // recover, or the process would need restarting to un-stick itself.
    if (req.method === 'GET' && url.pathname === '/_e2e/envelopes') {
      return json(res, 200, recorded);
    }
    if (req.method === 'POST' && url.pathname === '/_e2e/mode') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { error: 'INVALID_REQUEST' });
      }
      if (!VALID_MODES.includes(body.mode)) {
        return json(res, 400, { error: 'INVALID_REQUEST' });
      }
      mode = body.mode;
      return json(res, 200, { ok: true, mode });
    }
    if (req.method === 'POST' && url.pathname === '/_e2e/reset') {
      recorded = [];
      mode = 'ok';
      writeFileSync(RECORD_PATH, '');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/v1/search') {
      // `down` is checked before anything else, including auth — a genuinely
      // unreachable service never gets far enough to inspect headers either.
      // Destroying the socket (rather than answering, even with an error
      // status) is the point: the API's `fetch` must see a connection
      // failure, exactly like production unreachability, not a well-formed
      // 503 it could mistake for the service being merely unhealthy. Nothing
      // is recorded here — a genuinely unreachable peer never learns what
      // was sent either.
      if (mode === 'down') {
        req.socket.destroy();
        return;
      }

      const rawBody = await readBody(req);
      const classified = classifyRequest({ hasApiKey: Boolean(req.headers['x-api-key']), rawBody, mode });

      if (!classified.accepted || classified.status !== null) {
        // Either rejected (bad auth/shape) or an accepted request with an
        // early terminal outcome decided without touching the DB (currently
        // only anchor-not-found's 404) — either way, nothing left to do.
        recordRequest(classified);
        return json(res, classified.status, { error: classified.error });
      }

      if (mode === 'slow') {
        await sleep(6000); // past the client's 5s AbortSignal.timeout
      }

      const envelope = classified.envelope;
      let query;
      try {
        query = buildWhere(envelope);
      } catch (err) {
        if (err instanceof ClauseError) {
          recordRequest({ accepted: false, status: 400, error: 'INVALID_REQUEST', envelope });
          return json(res, 400, { error: 'INVALID_REQUEST' });
        }
        throw err;
      }

      try {
        const message = await executeSearch(pool, envelope.message.pagination, query);
        recordRequest({ accepted: true, status: 200, error: null, envelope });
        return json(res, 200, { context: envelope.context, message });
      } catch (err) {
        console.error('[search-stub] query failed', err);
        recordRequest({ accepted: true, status: 500, error: 'INTERNAL', envelope });
        return json(res, 500, { error: 'INTERNAL' });
      }
    }

    json(res, 404, { error: 'NOT_FOUND' });
  });
}

// Only bind Postgres + a port when this file is actually run as the entry
// point (`node search-stub.mjs`) — importing it for its pure exports (a
// future test importing buildWhere/executeSearch, say) must not require
// PGURL or claim a port as a side effect of module resolution.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const PORT = Number(process.env.SEARCH_STUB_PORT ?? 4546);
  const PGURL = process.env.PGURL;
  if (!PGURL) {
    console.error('[search-stub] PGURL is required — a Postgres connection string for the running dpg-db.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: PGURL, max: 2 });
  makeServer(pool).listen(PORT, () => console.log(`search stub on http://localhost:${PORT}`));
}

export { buildWhere, executeSearch, recordRequest, makeServer };
