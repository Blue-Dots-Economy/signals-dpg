/**
 * Client for the signals-search stub, plus the clause translation both the
 * stub and its tests share.
 *
 * The stub is also an assertion surface: it records every request envelope, so
 * a test can assert the API BUILT the right query rather than only that it
 * consumed the response. That is the one thing a real signals-search cannot
 * give us, and it guards a documented trap — an array-valued facet must map to
 * `contains_any` regardless of how many values are selected.
 */

export interface Envelope {
  context: { networkId: string; domain: string; itemType: string };
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

export function translateClause(c: { op: string; target: string; value: unknown }): { sql: string; params: unknown[] } {
  if (!c.target.startsWith('item_state.')) {
    throw new Error(`[e2e] search clause target "${c.target}" is outside item_state — the API must never expose another column as a facet`);
  }
  const field = c.target.slice('item_state.'.length);
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

  async envelopes(): Promise<Envelope[]> {
    const res = await fetch(`${this.baseUrl}/_e2e/envelopes`);
    if (!res.ok) throw new Error(`[e2e] search stub query failed: ${res.status}`);
    return (await res.json()) as Envelope[];
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
