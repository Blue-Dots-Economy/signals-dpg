/**
 * Client for the signals-search stub, plus the request-classification and
 * clause-translation logic the stub, its tests, AND the server share.
 *
 * The stub is also an assertion surface: it records every request — accepted
 * or rejected — so a test can assert the API BUILT the right query (not just
 * that it consumed the response) and that it never sent anything malformed or
 * unauthenticated. That is the one thing a real signals-search cannot give
 * us, and it guards a documented trap — an array-valued facet must map to
 * `contains_any` regardless of how many values are selected.
 *
 * `validationError`/`classifyRequest` live here rather than only in
 * search-stub.mjs so they're covered by this file's own DB-free unit tests
 * (search.test.ts) instead of only by a live run against Postgres — the same
 * reasoning that keeps `translateClause` here rather than duplicated in the
 * stub script.
 */

export interface Envelope {
  context: { version: string; messageId: string; networkId: string; domain: string; itemType: string };
  message: {
    intent: {
      textSearch?: string;
      filters?: Array<{ op: string; target: string; value: unknown }>;
      spatial?: Array<{ op: string; geometry: { coordinates: [number, number] }; distanceMeters?: number }>;
      item?: { id: string };
    };
    pagination: { limit: number; offset: number };
  };
}

export type SearchMode = 'ok' | 'down' | 'slow' | 'anchor-not-found';

/**
 * One entry in the stub's request log. Every POST /v1/search is recorded,
 * accepted or not — a rejected request (bad auth, bad shape) still carries a
 * `status`/`error` so a test can assert "the API never sent a malformed
 * envelope" by asserting `rejectedEnvelopes()` is empty, not merely that the
 * accepted ones look right.
 */
export interface RecordedRequest {
  accepted: boolean;
  /**
   * The final HTTP status the stub answered with, or `null` when `accepted`
   * is true and the outcome (200 vs 500) is only known after the DB query
   * runs — the stub fills this in once it does.
   */
  status: number | null;
  error: string | null;
  /** Parsed request body, or `null` when it couldn't even be parsed as JSON. */
  envelope: Envelope | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural validation of the Beckn-style envelope. Returns a message, or null when valid. */
export function validationError(body: unknown): string | null {
  if (!isPlainObject(body)) return 'body must be an object';
  const ctx = body.context;
  if (!isPlainObject(ctx) || ctx.version !== '1.0.0') return 'context.version must be "1.0.0"';
  if (typeof ctx.networkId !== 'string' || !ctx.networkId) return 'context.networkId is required';
  if (typeof ctx.domain !== 'string' || !ctx.domain) return 'context.domain is required';
  if (typeof ctx.itemType !== 'string' || !ctx.itemType) return 'context.itemType is required';

  const msg = body.message;
  if (!isPlainObject(msg) || !isPlainObject(msg.intent)) return 'message.intent is required';

  const spatial = msg.intent.spatial;
  if (spatial !== undefined && (!Array.isArray(spatial) || spatial.length > 1)) {
    return 'message.intent.spatial allows at most one clause';
  }
  const pag = msg.pagination;
  if (!isPlainObject(pag) || !Number.isInteger(pag.limit) || (pag.limit as number) < 1 || (pag.limit as number) > 100) {
    return 'message.pagination.limit must be an integer 1-100';
  }
  if (!Number.isInteger(pag.offset) || (pag.offset as number) < 0) {
    return 'message.pagination.offset must be a non-negative integer';
  }
  return null;
}

/**
 * Classifies one request into accept/reject before any DB work, so the
 * server can record + respond to a bad-auth or bad-shape request without
 * ever touching Postgres. Pure and synchronous — the one thing it can't
 * decide is the eventual 200-vs-500 for an accepted request that goes on to
 * query the DB, which is why `status`/`error` come back `null` in that case
 * (the caller fills them in once the query resolves).
 *
 * The envelope is captured whenever the body parses as JSON, REGARDLESS of
 * accept/reject — an audit trail is only useful if a rejected request is
 * still visible, not just the ones that made it through.
 */
export function classifyRequest(opts: { hasApiKey: boolean; rawBody: string; mode: SearchMode }): RecordedRequest {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(opts.rawBody);
  } catch {
    parsed = null;
  }
  const envelope = isPlainObject(parsed) ? (parsed as unknown as Envelope) : null;

  if (!opts.hasApiKey) {
    return { accepted: false, status: 401, error: 'UNAUTHORIZED', envelope };
  }
  if (envelope === null) {
    return { accepted: false, status: 400, error: 'INVALID_REQUEST', envelope: null };
  }
  const shapeErr = validationError(envelope);
  if (shapeErr) {
    return { accepted: false, status: 400, error: 'INVALID_REQUEST', envelope };
  }
  const hasAnchor = Boolean(envelope.message.intent.item);
  if (opts.mode === 'anchor-not-found' && hasAnchor) {
    return { accepted: true, status: 404, error: 'ANCHOR_NOT_FOUND', envelope };
  }
  return { accepted: true, status: null, error: null, envelope };
}

// A facet field is spliced into the SQL as a JSONB key literal (see
// translateClause below) — it is NOT a bind parameter, because it names a
// key, not a value. An allowlist is the guard: `^[A-Za-z0-9_]+$` is cheaper
// than quoting it as a real SQL identifier (format('%I', …)) since it's a
// JSONB key, not a column/table name, and it rejects a hostile target like
// `x') OR ('1'='1` outright rather than trying to escape it correctly.
const SAFE_FIELD_NAME = /^[A-Za-z0-9_]+$/;

export function translateClause(c: { op: string; target: string; value: unknown }): { sql: string; params: unknown[] } {
  if (!c.target.startsWith('item_state.')) {
    throw new Error(`[e2e] search clause target "${c.target}" is outside item_state — the API must never expose another column as a facet`);
  }
  const field = c.target.slice('item_state.'.length);
  if (!SAFE_FIELD_NAME.test(field)) {
    throw new Error(`[e2e] search clause target "${c.target}" has an unsafe field name — only letters, digits, and underscore are allowed`);
  }
  switch (c.op) {
    case 'contains_any':
      // jsonb `?|` overlap: correct for one OR many values on an array field.
      return { sql: `(i.item_state -> '${field}') ?| $1`, params: [c.value] };
    case 'in':
      return { sql: `(i.item_state ->> '${field}') = ANY($1)`, params: [c.value] };
    case 'eq':
      return { sql: `(i.item_state ->> '${field}') = $1`, params: [c.value] };
    case 'neq':
      return { sql: `(i.item_state ->> '${field}') <> $1`, params: [c.value] };
    default:
      throw new Error(`[e2e] unsupported search clause op "${c.op}"`);
  }
}

export class SearchStub {
  // NOT a constructor parameter property: `node --experimental-strip-types`
  // is strip-only and rejects that syntax outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, confirmed) — a plain field assigned
  // in the constructor body is the form that survives type-stripping.
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Every recorded request, accepted or not. */
  async envelopes(): Promise<RecordedRequest[]> {
    const res = await fetch(`${this.baseUrl}/_e2e/envelopes`);
    if (!res.ok) throw new Error(`[e2e] search stub query failed: ${res.status}`);
    return (await res.json()) as RecordedRequest[];
  }

  /** Convenience filter — the requests the API BUILT correctly (shape-valid), whatever the eventual status. */
  async acceptedEnvelopes(): Promise<RecordedRequest[]> {
    return (await this.envelopes()).filter((e) => e.accepted);
  }

  /** Convenience filter — assert this is EMPTY to prove the API never sent a malformed or unauthenticated request. */
  async rejectedEnvelopes(): Promise<RecordedRequest[]> {
    return (await this.envelopes()).filter((e) => !e.accepted);
  }

  async setMode(mode: SearchMode): Promise<void> {
    await fetch(`${this.baseUrl}/_e2e/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/_e2e/reset`, { method: 'POST' });
  }
}
