import { describe, it, expect, vi } from 'vitest';
import { parseNetworkConfigDocument } from '@dpg/schemas';
import {
  buildExport,
  FIXED_COLUMNS,
  type BuildExportInput,
  type ExportActionRow,
  type ExportItem,
} from '../build_export';

// #770: pure core of POST /action/export — eligibility, counterparty, reveal
// gate, skips, one-type-per-file, columns. No DB, no crypto.

const HERE = 'http://here.local';
const NET = 'blue_dot';
const T = 'profile_1';
const ME = 'user-me';
const OTHER = 'user-other';

const statusEvent = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['created', 'accepted', 'rejected'] } },
};
const inter = (from: string, to: string, requester: string[]) => ({
  from_domain: from,
  to_domain: to,
  requirement_schema: { type: 'object' },
  event_schema: statusEvent,
  reveals_pii_on_status: ['accepted'],
  export: { requester_domains: requester },
});
const rules = [{ status: 'new', when: 'default' }];

const CFG = parseNetworkConfigDocument({
  id: NET,
  domains: [
    {
      id: 'seeker',
      status_rules: rules,
      item_schemas: {
        [T]: {
          type: 'object',
          properties: {
            beneficiary_name: { type: 'string', private: true },
            mobile_number: { type: 'string', private: true },
            gender: { type: 'string' },
            looking_for: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    {
      id: 'provider',
      status_rules: rules,
      item_schemas: {
        [T]: {
          type: 'object',
          properties: {
            contact_name: { type: 'string', private: true },
            organisation_name: { type: 'string' },
          },
        },
      },
    },
    {
      id: 'service_provider',
      status_rules: rules,
      item_schemas: {
        [T]: { type: 'object', properties: { org: { type: 'string' } } },
      },
    },
  ],
  actions: {
    connect: {
      interactions: [
        inter('seeker', 'provider', ['provider']),
        inter('provider', 'seeker', ['provider']),
        inter('seeker', 'service_provider', ['service_provider']),
        inter('service_provider', 'seeker', ['service_provider']),
        inter('provider', 'service_provider', ['provider', 'service_provider']),
        inter('service_provider', 'provider', ['provider', 'service_provider']),
      ],
    },
  },
});

type Side = { id: string; domain: string; owner: string; instance?: string };
let n = 0;
const row = (
  source: Side,
  target: Side,
  status = 'accepted',
  extra: Partial<ExportActionRow> = {}
): ExportActionRow => ({
  action_id: `a${++n}`,
  action_type: 'connect',
  action_status: status,
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-02T00:00:00Z'),
  match_score: 0.81,
  source_item_id: source.id,
  source_item_network: NET,
  source_item_domain: source.domain,
  source_item_type: T,
  source_item_owner: source.owner,
  source_item_instance_url: source.instance ?? HERE,
  target_item_id: target.id,
  target_item_network: NET,
  target_item_domain: target.domain,
  target_item_type: T,
  target_item_owner: target.owner,
  target_item_instance_url: target.instance ?? HERE,
  ...extra,
});

const item = (
  id: string,
  domain: string,
  state: Record<string, unknown>,
  lifecycle = 'live'
): ExportItem => ({
  item_id: id,
  item_network: NET,
  item_domain: domain,
  item_type: T,
  item_state: state,
  item_private_state: `enc:${id}`,
  lifecycle_status: lifecycle,
});

const myProvider = { id: 'p-me', domain: 'provider', owner: ME };
const mySP = { id: 'sp-me', domain: 'service_provider', owner: ME };
const seekerA = { id: 's-a', domain: 'seeker', owner: OTHER };
const seekerB = { id: 's-b', domain: 'seeker', owner: OTHER };
const otherProvider = { id: 'p-x', domain: 'provider', owner: OTHER };

const REAL: Record<string, Record<string, unknown>> = {
  's-a': { beneficiary_name: 'Meera Kumari', mobile_number: '9876543210', gender: 'Female', looking_for: ['Education'] },
  's-b': { beneficiary_name: 'Ravi Das', mobile_number: '9876543211', gender: 'Male', looking_for: ['Pension'] },
};

const baseItems = () =>
  new Map<string, ExportItem>([
    ['p-me', item('p-me', 'provider', { organisation_name: 'Mine' })],
    ['sp-me', item('sp-me', 'service_provider', { org: 'Mine SP' })],
    ['s-a', item('s-a', 'seeker', { beneficiary_name: 'M***', mobile_number: '98******10', gender: 'Female', looking_for: ['Education'] })],
    ['s-b', item('s-b', 'seeker', { beneficiary_name: 'R***', mobile_number: '98******11', gender: 'Male', looking_for: ['Pension'] })],
    ['p-x', item('p-x', 'provider', { contact_name: 'A***', organisation_name: 'Other Org' })],
  ]);

const input = (over: Partial<BuildExportInput>): BuildExportInput => ({
  userId: ME,
  currentInstanceUrl: HERE,
  rows: [],
  items: baseItems(),
  getNetworkConfig: (id) => (id === NET ? CFG : null),
  filters: {},
  projection: { fields: '*' },
  include: [],
  decrypt: (it) => REAL[it.item_id] ?? it.item_state,
  ...over,
});

const okOf = (r: ReturnType<typeof buildExport>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.status} ${r.error}`);
  return r;
};
const col = (r: ReturnType<typeof okOf>, name: string) => r.header.indexOf(name);

describe('buildExport — counterparty and columns', () => {
  it('exports the counterparty for both received and initiated rows', () => {
    const received = row(seekerA, myProvider); // seeker → me
    const initiated = row(myProvider, seekerB); // me → seeker
    const r = okOf(buildExport(input({ rows: [received, initiated] })));

    expect(r.counterparty).toEqual({ network: NET, domain: 'seeker', item_type: T });
    expect(r.header).toEqual([
      ...FIXED_COLUMNS,
      'beneficiary_name',
      'mobile_number',
      'gender',
      'looking_for',
    ]);
    expect(r.records.map((rec) => rec[col(r, 'counterparty_item_id')])).toEqual(['s-a', 's-b']);
    expect(r.records.map((rec) => rec[col(r, 'direction')])).toEqual(['received', 'initiated']);
  });

  it('never exports the requester’s own item', () => {
    const r = okOf(buildExport(input({ rows: [row(seekerA, myProvider)] })));
    expect(r.records.flat()).not.toContain('p-me');
  });

  it('adds match_score after the fixed columns when included', () => {
    const r = okOf(
      buildExport(input({ rows: [row(seekerA, myProvider)], include: ['match_score'] }))
    );
    expect(r.header[FIXED_COLUMNS.length]).toBe('match_score');
    expect(r.records[0][FIXED_COLUMNS.length]).toBe(0.81);
  });

  it('honours a field list projection', () => {
    const r = okOf(
      buildExport(
        input({ rows: [row(seekerA, myProvider)], projection: { fields: ['gender', 'beneficiary_name'] } })
      )
    );
    expect(r.header.slice(FIXED_COLUMNS.length)).toEqual(['beneficiary_name', 'gender']);
  });

  it('rejects an unknown projection field with 400 UNKNOWN_FIELD', () => {
    const r = buildExport(
      input({ rows: [row(seekerA, myProvider)], projection: { fields: ['phone'] } })
    );
    expect(r).toMatchObject({ ok: false, status: 400, error: 'UNKNOWN_FIELD', details: { fields: ['phone'] } });
  });

  it('empty row set → fixed columns only, no counterparty', () => {
    const r = okOf(buildExport(input({ rows: [] })));
    expect(r.header).toEqual([...FIXED_COLUMNS]);
    expect(r.records).toEqual([]);
    expect(r.counterparty).toBeUndefined();
  });
});

describe('buildExport — reveal gate', () => {
  it('accepted + both live → decrypted, pii_revealed=true', () => {
    const r = okOf(buildExport(input({ rows: [row(seekerA, myProvider)] })));
    const rec = r.records[0];
    expect(rec[col(r, 'beneficiary_name')]).toBe('Meera Kumari');
    expect(rec[col(r, 'mobile_number')]).toBe('9876543210');
    expect(rec[col(r, 'pii_revealed')]).toBe(true);
    expect(r.counts).toMatchObject({ row_count: 1, revealed_count: 1, masked_count: 0 });
  });

  it('a status outside reveals_pii_on_status is never exported (skipped, counted)', () => {
    const r = okOf(
      buildExport(input({ rows: [row(seekerA, myProvider), row(seekerB, myProvider, 'created')] }))
    );
    expect(r.records.map((rec) => rec[col(r, 'counterparty_item_id')])).toEqual(['s-a']);
    expect(r.counts.skipped_not_enabled).toBe(1);
  });

  it('only non-exportable statuses → 403, nothing exported', () => {
    const r = buildExport(input({ rows: [row(seekerA, myProvider, 'created')] }));
    expect(r).toMatchObject({ ok: false, status: 403, error: 'EXPORT_NOT_ENABLED' });
  });

  it('lists every revealed row for the per-subject reveal audit', () => {
    const items = baseItems();
    items.set('s-b', { ...items.get('s-b')!, lifecycle_status: 'paused' });
    const a = row(seekerA, myProvider);
    const b = row(seekerB, myProvider);
    const r = okOf(buildExport(input({ rows: [a, b], items })));
    // s-b is paused → masked → not a reveal.
    expect(r.reveals).toEqual([
      {
        action_id: a.action_id,
        action_type: 'connect',
        action_status: 'accepted',
        item_id: 's-a',
        item_owner: OTHER,
      },
    ]);
  });

  it('counterparty paused → masked', () => {
    const items = baseItems();
    items.set('s-a', { ...items.get('s-a')!, lifecycle_status: 'paused' });
    const r = okOf(buildExport(input({ rows: [row(seekerA, myProvider)], items })));
    expect(r.records[0][col(r, 'beneficiary_name')]).toBe('M***');
  });

  it('requester’s own profile paused → masked', () => {
    const items = baseItems();
    items.set('p-me', { ...items.get('p-me')!, lifecycle_status: 'paused' });
    const r = okOf(buildExport(input({ rows: [row(seekerA, myProvider)], items })));
    expect(r.records[0][col(r, 'pii_revealed')]).toBe(false);
  });

  it('decrypt failure → masked row and the error is reported', () => {
    const onDecryptError = vi.fn();
    const r = okOf(
      buildExport(
        input({
          rows: [row(seekerA, myProvider)],
          decrypt: () => {
            throw new Error('bad blob');
          },
          onDecryptError,
        })
      )
    );
    expect(r.records[0][col(r, 'beneficiary_name')]).toBe('M***');
    expect(r.records[0][col(r, 'pii_revealed')]).toBe(false);
    expect(onDecryptError).toHaveBeenCalledWith(expect.any(Error), 's-a');
  });
});

describe('buildExport — skips', () => {
  it('counts cross-instance, missing and self rows instead of emitting them', () => {
    const remote = { ...seekerA, id: 's-remote', instance: 'http://peer.local' };
    const gone = { ...seekerA, id: 's-gone' };
    const mine = { id: 's-mine', domain: 'seeker', owner: ME }; // legacy two-domain account
    const r = okOf(
      buildExport(
        input({
          rows: [
            row(seekerA, myProvider),
            row(remote, myProvider),
            row(gone, myProvider),
            row(mine, myProvider),
          ],
        })
      )
    );
    expect(r.records).toHaveLength(1);
    expect(r.counts).toMatchObject({
      row_count: 1,
      skipped_cross_instance: 1,
      skipped_missing: 1,
      skipped_self: 1,
    });
  });
});

describe('buildExport — config failures are errors, not "not enabled"', () => {
  it('missing network config for a row → 500 NETWORK_CONFIG_UNAVAILABLE', () => {
    const r = buildExport(input({ rows: [row(seekerA, myProvider)], getNetworkConfig: () => null }));
    expect(r).toMatchObject({ ok: false, status: 500, error: 'NETWORK_CONFIG_UNAVAILABLE' });
  });

  it('missing counterparty network config → 500, not a thrown error', () => {
    const r = buildExport(
      input({
        rows: [row(seekerA, myProvider)],
        items: new Map([
          ...baseItems(),
          ['s-a', { ...baseItems().get('s-a')!, item_network: 'elsewhere' }],
        ]),
      })
    );
    expect(r).toMatchObject({ ok: false, status: 500, error: 'NETWORK_CONFIG_UNAVAILABLE' });
  });

  it('an undeclared interaction is reported, then treated as not exportable', () => {
    const onRuleError = vi.fn();
    const r = buildExport(
      input({ rows: [row(seekerA, myProvider, 'accepted', { action_type: 'apply' })], onRuleError })
    );
    expect(r).toMatchObject({ ok: false, status: 403, error: 'EXPORT_NOT_ENABLED' });
    expect(onRuleError).toHaveBeenCalledWith(expect.any(Error), expect.any(String));
  });
});

describe('buildExport — eligibility', () => {
  it('a seeker (no export entitlement) gets 403 EXPORT_NOT_ENABLED', () => {
    const meSeeker = { id: 's-me', domain: 'seeker', owner: ME };
    const items = baseItems();
    items.set('s-me', item('s-me', 'seeker', {}));
    const r = buildExport(input({ rows: [row(meSeeker, otherProvider)], items }));
    expect(r).toMatchObject({ ok: false, status: 403, error: 'EXPORT_NOT_ENABLED' });
  });

  it('rows on a non-exportable interaction are counted, not silently dropped', () => {
    const cfg = parseNetworkConfigDocument({
      id: NET,
      domains: CFG.domains.map((d) => ({ ...d, item_schemas: d.item_schemas })),
      actions: {
        connect: {
          interactions: [
            inter('seeker', 'provider', ['provider']),
            { ...inter('provider', 'seeker', ['provider']), export: undefined },
          ],
        },
      },
    });
    const r = okOf(
      buildExport(
        input({
          rows: [row(seekerA, myProvider), row(myProvider, seekerB)],
          getNetworkConfig: () => cfg,
        })
      )
    );
    expect(r.records).toHaveLength(1);
    expect(r.counts.skipped_not_enabled).toBe(1);
  });

  it('an interaction the network does not declare is not exportable', () => {
    const r = buildExport(
      input({ rows: [row(seekerA, myProvider, 'accepted', { action_type: 'apply' })] })
    );
    expect(r).toMatchObject({ ok: false, status: 403, error: 'EXPORT_NOT_ENABLED' });
  });
});

describe('buildExport — one counterparty type per file', () => {
  const spRows = () => [row(seekerA, mySP), row(otherProvider, mySP)];

  it('mixed seeker + provider counterparties → 400 with the types', () => {
    const r = buildExport(input({ rows: spRows() }));
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'MIXED_COUNTERPARTY_TYPES',
      details: { counterparty_domains: ['provider', 'seeker'] },
    });
  });

  it('counterparty_domain selects one type', () => {
    const r = okOf(buildExport(input({ rows: spRows(), filters: { counterparty_domain: 'provider' } })));
    expect(r.counterparty?.domain).toBe('provider');
    expect(r.header.slice(FIXED_COLUMNS.length)).toEqual(['contact_name', 'organisation_name']);
    expect(r.records).toHaveLength(1);
  });
});

describe('buildExport — facets', () => {
  it('filters on a declared non-private field', () => {
    const r = okOf(
      buildExport(
        input({
          rows: [row(seekerA, myProvider), row(seekerB, myProvider)],
          filters: { facets: [{ field: 'gender', values: ['Male'] }] },
        })
      )
    );
    expect(r.records.map((rec) => rec[col(r, 'counterparty_item_id')])).toEqual(['s-b']);
  });

  it('ignores a facet on a private field (never filterable)', () => {
    const r = okOf(
      buildExport(
        input({
          rows: [row(seekerA, myProvider), row(seekerB, myProvider)],
          filters: { facets: [{ field: 'beneficiary_name', values: ['nobody'] }] },
        })
      )
    );
    expect(r.records).toHaveLength(2);
  });
});
