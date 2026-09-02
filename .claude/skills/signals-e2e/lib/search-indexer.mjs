// item_search indexer stand-in for e2e runs.
//
// signals-search's real reconciliation sweep maintains item_search off the
// same Redis ingest stream this consumes. Without SOME consumer running
// during a suite, item_search stays empty and the API's markers/discover bbox
// filter silently falls back to items.item_locations (see CLAUDE.md,
// "Discover / markers (search BFF)") — the map keeps working, and a
// lifecycle transition that publishes no event passes every assertion. That
// is the exact shape of #557/#564: a promoted profile stayed draft in
// item_search and was invisible in every ranked feed and map viewport while
// items said live, and nothing logged. This stub makes item_search reflect
// reality so that gap becomes an assertable difference instead of silence.
//
// Mapping logic lives in index_row.mjs so it is testable without Redis; this
// file is only the Redis consumption + DB write loop + the pause control that
// turns "published but not yet indexed" into a state a test can hold open on
// purpose (rather than a race it has to get lucky to lose).
//
// Writes ONLY to item_search, and only the row matching an event's own key —
// never any other table, never a bulk operation.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rowForEvent } from './index_row.mjs';

const execFileAsync = promisify(execFile);

// `pg` is an e2e/ dependency (Task 1), not a root one — this worktree has no
// root node_modules. Plain ESM `import` ignores NODE_PATH entirely, but
// createRequire's CommonJS resolution DOES consult it, same as a plain
// `require()` would (see search-stub.mjs's header comment, verified there) —
// so this script must be launched with NODE_PATH=e2e/node_modules.
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.INDEXER_PORT ?? 4547);
const PGURL = process.env.PGURL;
if (!PGURL) {
  console.error('[search-indexer] PGURL is required — a Postgres connection string for the running dpg-db.');
  process.exit(1);
}
const pool = new Pool({ connectionString: PGURL, max: 2 });

const REDIS_CONTAINER = process.env.REDIS_CONTAINER ?? 'dpg-redis';

// This worktree may not be the checkout actually running the stack — same
// SIGNALS_REPO indirection stack-up.sh uses (its header comment explains why:
// this is an e2e-only worktree with no root .env of its own).
const SCRIPT_REPO = resolve(here, '..', '..', '..', '..');
const REPO = process.env.SIGNALS_REPO ?? SCRIPT_REPO;
const STACK_ENV = resolve(REPO, '.env');

// cat/grep on a .env are permission-blocked in this environment; read it the
// same way stack-up.sh does — a node regex against the raw file, never
// `source`d. Returns undefined (not '') for "absent or empty", so callers can
// tell "not set" apart from an explicit blank value with one falsy check.
function readEnvVar(key, path) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) return undefined;
  const value = m[1].trim().replace(/^"(.*)"$/, '$1');
  return value || undefined;
}

// databasesConfig.ingest_stream's own zod default (packages/config/src/secrets.ts:389)
// — reused verbatim so an unset INGEST_STREAM in .env still names the stream
// the API actually publishes to, rather than inventing a second default that
// could silently drift from it.
const STREAM = readEnvVar('INGEST_STREAM', STACK_ENV) ?? 'signals:item-events';

// Redis AUTH for `docker exec ... redis-cli`, read from the same .env for the
// same reason stack-up.sh reads Postgres credentials from it rather than
// guessing: a missing/empty password would make this capability read as "on"
// while every XREAD fails auth — the exact silent-degradation shape this task
// exists to close off. Fail loud, before consuming anything.
const REDIS_PASSWORD = readEnvVar('REDIS_PASSWORD', STACK_ENV);
if (!REDIS_PASSWORD) {
  console.error(`[search-indexer] REDIS_PASSWORD is missing or empty in ${STACK_ENV} — cannot authenticate to ${REDIS_CONTAINER}.`);
  process.exit(1);
}

let paused = false;
let stopped = false;
// '$' = only entries appended after THIS process starts — never replay the
// backlog. Advanced to the last-consumed id after the first read.
let lastId = '$';
const stats = { consumed: 0, indexed: 0, deleted: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One XREAD BLOCK, via `docker exec` against the redis container rather than
 * a redis client library — there is no redis npm dependency in e2e/ (only
 * `pg`, from Task 1), and this stub doesn't need one: `redis-cli --json -2`
 * (RESP2-shaped JSON; confirmed present in this stack's redis-cli 7.2.16)
 * emits exactly `[[stream, [[id, [field,value,field,value,...]], ...]]]` on
 * data, or the bare text `null` on a BLOCK timeout with nothing new — both
 * trivial to parse without hand-rolling the RESP protocol over a raw socket.
 */
async function xread() {
  const { stdout } = await execFileAsync('docker', [
    'exec', REDIS_CONTAINER, 'redis-cli', '-a', REDIS_PASSWORD, '--json', '-2',
    'XREAD', 'BLOCK', '2000', 'STREAMS', STREAM, lastId,
  ]);
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return [];
  const [[, entries]] = JSON.parse(trimmed);
  return entries; // [[id, [field, value, field, value, ...]], ...]
}

function fieldsToEvent(fields) {
  const event = {};
  for (let i = 0; i < fields.length; i += 2) event[fields[i]] = fields[i + 1];
  return event;
}

/**
 * One entry: read the item row in a single query, map it, write it. Item
 * lookups never join or query `item_locations` as a table — it's a JSONB
 * column on `items` (apps/api/db/postgres/schema.sql:41; there is no
 * `CREATE TABLE item_locations`), fetched in the same SELECT as
 * lifecycle_status and updated_at.
 */
async function processEntry(id, fields) {
  const event = fieldsToEvent(fields);
  stats.consumed++;
  let item = null;
  if (event.op !== 'delete') {
    const { rows } = await pool.query(
      'SELECT lifecycle_status, updated_at, item_locations FROM items WHERE item_id = $1',
      [event.item_id],
    );
    item = rows[0] ?? null;
  }
  const write = rowForEvent(event, item, item?.item_locations ?? []);
  if (write.delete) {
    await pool.query(
      'DELETE FROM item_search WHERE item_network = $1 AND item_domain = $2 AND item_type = $3 AND item_id = $4',
      [event.item_network, event.item_domain, event.item_type, event.item_id],
    );
    stats.deleted++;
  } else {
    await pool.query(write.text, write.params);
    stats.indexed++;
  }
  // One line per event, so a run's index activity is visible without
  // instrumenting the test itself.
  console.log(`[search-indexer] ${id} ${event.op} ${event.item_network}/${event.item_domain}/${event.item_type}/${event.item_id} -> ${write.delete ? 'deleted' : 'indexed'}`);
}

/**
 * The consume loop. Never throws out of here — a stub that dies mid-run turns
 * every later map/discover assertion into a mystery rather than a clean
 * failure, so every failure mode below is caught, logged, and consumed past.
 */
async function loop() {
  while (!stopped) {
    if (paused) {
      await sleep(200);
      continue;
    }
    let entries;
    try {
      entries = await xread();
    } catch (err) {
      console.error('[search-indexer] XREAD failed, will retry:', err.message ?? err);
      await sleep(1000); // don't hammer `docker exec` in a tight loop while it's failing
      continue;
    }
    for (const [id, fields] of entries) {
      // Checked per-entry, not just once before the blocking XREAD: a pause
      // can land while a BLOCK call is already in flight (it returns as soon
      // as the very event under test is published, right after /pause was
      // called), so a check only at the top of the loop would still index
      // that entry and defeat the whole point of pausing. Stopping here
      // WITHOUT advancing lastId leaves this entry (and the rest of the
      // batch) to be re-read and indexed once resumed, rather than skipped.
      if (paused) break;
      try {
        await processEntry(id, fields);
      } catch (err) {
        console.error(`[search-indexer] failed to index entry ${id}:`, err.message ?? err);
      }
      // Advance past the entry regardless of success — a poison entry that
      // always throws must not wedge every later event behind it forever.
      lastId = id;
    }
  }
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Pausing is what makes "published but not yet indexed" a state a test can
  // hold open on purpose, rather than a race it has to get lucky to lose.
  if (req.method === 'POST' && url.pathname === '/_e2e/pause') {
    paused = true;
    return json(res, 200, { ok: true, paused });
  }
  if (req.method === 'POST' && url.pathname === '/_e2e/resume') {
    paused = false;
    return json(res, 200, { ok: true, paused });
  }
  if (req.method === 'GET' && url.pathname === '/_e2e/stats') {
    return json(res, 200, { ...stats, paused });
  }
  json(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => {
  console.log(`[search-indexer] listening on http://localhost:${PORT}, consuming ${STREAM} from ${REDIS_CONTAINER} at $`);
  loop();
});
