import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * #770 — POST /api/v1/action/export, route concerns only: auth, item
 * ownership, the row cap, one-export-at-a-time, the audit row (fail-closed),
 * response headers and body. The export rules themselves (eligibility,
 * counterparty, reveal gate, skips, columns) are covered in
 * services/action_export/__tests__/build_export.test.ts.
 */

vi.mock('@/config', () => ({
  apiConfig: { export_max_rows: 2, export_timezone: 'Asia/Kolkata', export_rate_limit_per_hour: 3 },
  getCurrentApiBaseUrl: () => 'http://here.local',
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

const NET = 'net1';
const T = 'profile_1';
const ME = 'user-me';

const { parseNetworkConfigDocument } = await import('@dpg/schemas');
const CFG = parseNetworkConfigDocument({
  id: NET,
  domains: [
    {
      id: 'seeker',
      status_rules: [{ status: 'new', when: 'default' }],
      item_schemas: {
        [T]: {
          type: 'object',
          properties: {
            beneficiary_name: { type: 'string', private: true },
            gender: { type: 'string' },
          },
        },
      },
    },
    {
      id: 'provider',
      status_rules: [{ status: 'new', when: 'default' }],
      item_schemas: { [T]: { type: 'object', properties: { org: { type: 'string' } } } },
    },
  ],
  actions: {
    connect: {
      interactions: [
        {
          from_domain: 'seeker',
          to_domain: 'provider',
          requirement_schema: { type: 'object' },
          event_schema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['created', 'accepted'] } },
          },
          reveals_pii_on_status: ['accepted'],
          export: { requester_domains: ['provider'] },
        },
      ],
    },
  },
});

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => CFG),
}));

vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: vi.fn(() => ({
    mergedState: { beneficiary_name: 'Meera Kumari', gender: 'Female' },
  })),
}));

// db: `select` calls are answered from a queue in call order; `insert`
// records the audit row (or throws when told to).
const state = {
  selects: [] as unknown[][],
  logs: [] as Array<Record<string, unknown>>,
  revealAudit: [] as Array<Record<string, unknown>>,
  auditThrows: false,
  holdRows: null as Promise<void> | null,
  rateCount: 1,
  rateThrows: false,
};

vi.mock('@/utils/rate_window', () => ({
  incrWithinWindow: vi.fn(async () => {
    if (state.rateThrows) throw new Error('redis down');
    return state.rateCount;
  }),
}));

function chain(result: () => Promise<unknown[]>) {
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => node,
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) => result().then(res, rej),
  };
  return node;
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () =>
      chain(async () => {
        const next = state.selects.shift() ?? [];
        if (state.holdRows) await state.holdRows;
        return next;
      }),
    // pii_reveal_audit rows are written in a transaction (both-or-neither).
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const staged: Array<Record<string, unknown>> = [];
      await fn({
        insert: () => ({
          values: async (v: Record<string, unknown> | Array<Record<string, unknown>>) => {
            if (state.auditThrows) throw new Error('audit down');
            staged.push(...(Array.isArray(v) ? v : [v]));
          },
        }),
      });
      state.revealAudit.push(...staged);
    },
  },
}));

const { export_actions } = await import('../export_actions');

const actionRow = (id: string) => ({
  action_id: id,
  action_type: 'connect',
  action_status: 'accepted',
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-02T00:00:00Z'),
  match_score: null,
  source_item_id: `s-${id}`,
  source_item_network: NET,
  source_item_domain: 'seeker',
  source_item_type: T,
  source_item_owner: 'user-other',
  source_item_instance_url: 'http://here.local',
  target_item_id: 'p-me',
  target_item_network: NET,
  target_item_domain: 'provider',
  target_item_type: T,
  target_item_owner: ME,
  target_item_instance_url: 'http://here.local',
});
// The caller's own profile the route resolves first (one domain per user).
const requesterRow = (userId = ME, domain = 'provider') => ({
  item_id: 'p-me',
  created_by: userId,
  item_network: NET,
  item_domain: domain,
});
const itemRow = (id: string, domain: string, st: Record<string, unknown>) => ({
  item_id: id,
  item_network: NET,
  item_domain: domain,
  item_type: T,
  item_state: st,
  item_private_state: 'enc',
  lifecycle_status: 'live',
});

async function buildApp(userId: string | null = ME, role = 'user'): Promise<FastifyInstance> {
  // Capture structured log lines: the download audit is a log record.
  const stream = {
    write: (line: string) => {
      state.logs.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  const app = Fastify({ logger: { level: 'info', stream } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    if (userId) (req as unknown as { user: { id: string; role: string } }).user = { id: userId, role };
  });
  await app.register(export_actions, { prefix: '/api/v1/action' });
  await app.ready();
  return app;
}

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/action/export', payload: payload as object });

beforeEach(() => {
  state.selects = [];
  state.logs = [];
  state.revealAudit = [];
  state.auditThrows = false;
  state.holdRows = null;
  state.rateCount = 1;
  state.rateThrows = false;
});

describe('POST /api/v1/action/export', () => {
  it('401 without a user', async () => {
    const app = await buildApp(null);
    expect((await post(app, {})).statusCode).toBe(401);
  });

  it('400 on an invalid body', async () => {
    const app = await buildApp();
    expect((await post(app, { format: 'xlsx' })).statusCode).toBe(400);
  });

  it('403 when item_id is not the caller’s', async () => {
    const app = await buildApp();
    state.selects = [[{ created_by: 'someone-else' }]];
    const res = await post(app, { filters: { item_id: '3f9a1c2e-0000-4000-8000-000000000001' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN_ITEM');
  });

  it('413 when rows exceed EXPORT_MAX_ROWS', async () => {
    const app = await buildApp();
    state.selects = [[requesterRow()], [actionRow('a1'), actionRow('a2'), actionRow('a3')]];
    const res = await post(app, {});
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'EXPORT_TOO_LARGE', details: { max_rows: 2 } });
    expect(auditLogs()).toHaveLength(0);
  });

  it('200: CSV body, PII-free filename, X-Export-* headers, one audit row', async () => {
    const app = await buildApp();
    state.selects = [
      [requesterRow()],
      [actionRow('a1')],
      [
        itemRow('s-a1', 'seeker', { beneficiary_name: 'M***', gender: 'Female' }),
        itemRow('p-me', 'provider', { org: 'Mine' }),
      ],
    ];
    const res = await post(app, { filters: { action_status: ['accepted'] } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const exportId = res.headers['x-export-id'] as string;
    expect(exportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="net1_seeker_accepted_${exportId.slice(0, 8)}_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\+0530\\.csv"$`)
    );
    expect(res.headers['content-disposition']).not.toContain('Meera');
    expect(res.headers['x-export-row-count']).toBe('1');
    expect(res.headers['x-export-skipped-cross-instance']).toBe('0');
    expect(res.headers['x-export-skipped-missing']).toBe('0');
    expect(res.headers['x-export-skipped-self']).toBe('0');
    expect(res.headers['x-export-skipped-not-enabled']).toBe('0');
    expect(res.headers['x-export-generated-at']).toMatch(/\+05:30$/);
    // Every X-Export-* header the route sets is exposed to the cross-origin UI.
    const { EXPORT_EXPOSED_HEADERS } = await import('@/services/action_export/headers');
    const exposed = EXPORT_EXPOSED_HEADERS.map((h) => h.toLowerCase());
    for (const h of Object.keys(res.headers).filter((k) => k.startsWith('x-export-'))) {
      expect(exposed).toContain(h);
    }
    expect(exposed).toContain('content-disposition');

    const lines = res.body.replace(/^﻿/, '').split('\r\n');
    expect(res.body.startsWith('﻿')).toBe(true); // Excel reads UTF-8 names correctly
    expect(lines[0]).toBe(
      'action_id,action_type,action_status,direction,counterparty_item_id,counterparty_domain,counterparty_item_type,created_at,updated_at,pii_revealed,beneficiary_name,gender'
    );
    expect(lines[1]).toContain('a1,connect,accepted,received,s-a1,seeker,profile_1');
    // Dates in EXPORT_TIMEZONE (IST), with the offset.
    expect(lines[1]).toContain(',2026-09-01T05:30:00+05:30,2026-09-02T05:30:00+05:30,');
    expect(lines[1]).toContain('true,Meera Kumari,Female');

    // Download audit = one structured log line (no table), tied to the file
    // by export_id.
    expect(auditLogs()).toHaveLength(1);
    expect(auditLogs()[0]).toMatchObject({
      export_id: exportId,
      requester_user_id: ME,
      requester_item_id: 'p-me',
      format: 'csv',
      row_count: 1,
      revealed_count: 1,
      masked_count: 0,
      counterparty_domain: 'seeker',
      filters: { ownership_role: 'all', action_status: ['accepted'] },
      projection: { fields: '*' },
    });
    // Never the exported values.
    expect(JSON.stringify(auditLogs()[0])).not.toContain('Meera');
  });

  it('a domain with no export entitlement is refused before any rows load', async () => {
    const app = await buildApp('user-other'); // a seeker — not entitled
    state.selects = [[requesterRow('user-other', 'seeker')]];
    const res = await post(app, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('EXPORT_NOT_ENABLED');
    expect(state.selects).toHaveLength(0);
    expect(auditLogs()).toHaveLength(0);
  });

  it('403 for a caller with no profile at all', async () => {
    const app = await buildApp();
    state.selects = [[]];
    expect((await post(app, {})).json().error).toBe('EXPORT_NOT_ENABLED');
  });

  it('403 SERVICE_CALLER_NOT_ALLOWED for a service identity (API key / client credentials)', async () => {
    const app = await buildApp('svc-user', 'service');
    const res = await post(app, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SERVICE_CALLER_NOT_ALLOWED');
  });

  it('400 STATUS_NOT_EXPORTABLE when asking for a status the network does not reveal on', async () => {
    const app = await buildApp();
    state.selects = [[requesterRow()]];
    const res = await post(app, { filters: { action_status: ['accepted', 'created'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'STATUS_NOT_EXPORTABLE',
      details: { not_exportable: ['created'], allowed: ['accepted'] },
    });
  });

  it('with no status filter, only exportable statuses are queried (and recorded)', async () => {
    const app = await buildApp();
    state.selects = [[requesterRow()], [actionRow('a1')], [itemRow('s-a1', 'seeker', {}), itemRow('p-me', 'provider', {})]];
    const res = await post(app, {});
    expect(res.statusCode).toBe(200);
    expect(auditLogs()[0]).toMatchObject({ filters: { action_status: ['accepted'] } });
  });

  it('413 before any query when action_ids exceed EXPORT_MAX_ROWS', async () => {
    const app = await buildApp();
    const ids = [1, 2, 3].map((i) => `3f9a1c2e-0000-4000-8000-00000000000${i}`);
    const res = await post(app, { filters: { action_ids: ids } });
    expect(res.statusCode).toBe(413);
  });

  it('429 EXPORT_RATE_LIMITED past the hourly limit', async () => {
    const app = await buildApp();
    state.rateCount = 4; // limit is 3
    const res = await post(app, {});
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('EXPORT_RATE_LIMITED');
  });

  it('503 when the rate limiter is unavailable (fails closed)', async () => {
    const app = await buildApp();
    state.rateThrows = true;
    const res = await post(app, {});
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('EXPORT_RATE_LIMIT_UNAVAILABLE');
  });

  it('writes one pii_reveal_audit row per revealed counterparty, with the download row', async () => {
    const app = await buildApp();
    state.selects = [
      [requesterRow()],
      [actionRow('a1')],
      [itemRow('s-a1', 'seeker', { beneficiary_name: 'M***' }), itemRow('p-me', 'provider', {})],
    ];
    const res = await post(app, {});
    expect(res.statusCode).toBe(200);
    expect(auditLogs()).toHaveLength(1);
    expect(state.revealAudit).toEqual([
      {
        actionId: 'a1',
        viewerUserId: ME,
        revealedItemId: 's-a1',
        revealedItemOwner: 'user-other',
        revealedActionType: 'connect',
        revealedActionStatusAtView: 'accepted',
      },
    ]);
  });

  it('500 and no file when the audit row cannot be written (fail-closed)', async () => {
    const app = await buildApp();
    state.auditThrows = true;
    state.selects = [[requesterRow()], [actionRow('a1')], [itemRow('s-a1', 'seeker', {}), itemRow('p-me', 'provider', {})]];
    const res = await post(app, {});
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('EXPORT_AUDIT_FAILED');
    expect(res.body).not.toContain('Meera');
    // Nothing half-written: the transaction commits both or neither.
    expect(auditLogs()).toHaveLength(0);
    expect(state.revealAudit).toHaveLength(0);
  });

  it('429 while the same user already has an export running', async () => {
    const app = await buildApp();
    let release!: () => void;
    state.holdRows = new Promise<void>((r) => (release = r));
    state.selects = [[requesterRow()], [], [requesterRow()], []];
    const first = post(app, {});
    await new Promise((r) => setTimeout(r, 10));
    const second = await post(app, {});
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe('EXPORT_IN_PROGRESS');
    release();
    expect((await first).statusCode).toBe(200);
    // Lock released afterwards.
    state.holdRows = null;
    expect((await post(app, {})).statusCode).toBe(200);
  });
});

/** The download-level audit log line(s) written by the route. */
const auditLogs = () => state.logs.filter((l) => l.operation === 'action.export.audit');
