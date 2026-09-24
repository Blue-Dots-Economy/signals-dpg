import { describe, it, expect } from 'vitest';
import {
  NetworkActionInteractionSchema,
  parseNetworkConfigDocument,
  getInteractionExportRequesterDomains,
  getExportableCounterparties,
} from '../network_workflow';

// #769 (SS-5.1): per-interaction bulk-export eligibility.

const base = {
  from_domain: 'seeker',
  to_domain: 'provider',
  requirement_schema: { type: 'object' },
};

describe('interaction export block — schema', () => {
  it('is optional and stays undefined when absent (fail-closed)', () => {
    const result = NetworkActionInteractionSchema.safeParse({ ...base });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.export).toBeUndefined();
  });

  it('accepts requester_domains naming a party to the interaction', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      export: { requester_domains: ['provider'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts both parties', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      export: { requester_domains: ['seeker', 'provider'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a requester domain that is not a party to the interaction', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      export: { requester_domains: ['service_provider'] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'export.requester_domains value "service_provider" is not a party to this interaction (from_domain "seeker", to_domain "provider")',
      );
      expect(result.error.issues[0].path).toEqual(['export', 'requester_domains', 0]);
    }
  });

  it('rejects an empty requester_domains list', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      export: { requester_domains: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in the export block', () => {
    const result = NetworkActionInteractionSchema.safeParse({
      ...base,
      export: { requester_domains: ['provider'], max_rows: 10 },
    });
    expect(result.success).toBe(false);
  });
});

const statusEvent = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['created', 'accepted', 'rejected'] } },
};

const interaction = (
  from_domain: string,
  to_domain: string,
  requester_domains?: string[],
) => ({
  from_domain,
  to_domain,
  requirement_schema: { type: 'object' },
  event_schema: statusEvent,
  reveals_pii_on_status: ['accepted'],
  ...(requester_domains ? { export: { requester_domains } } : {}),
});

const domain = (id: string) => ({
  id,
  item_schemas: { profile_1: { type: 'object', properties: {} } },
  status_rules: [{ status: 'new', when: 'default' }],
});

// Mirrors the blue_dot brand matrix (up-gzb / ka-dhwd).
const blueDotLike = parseNetworkConfigDocument({
  id: 'blue_dot',
  domains: [domain('seeker'), domain('provider'), domain('service_provider')],
  actions: {
    apply: { interactions: [interaction('seeker', 'provider', ['provider'])] },
    connect: {
      interactions: [
        interaction('provider', 'seeker', ['provider']),
        interaction('seeker', 'service_provider', ['service_provider']),
        interaction('service_provider', 'seeker', ['service_provider']),
        interaction('provider', 'service_provider', ['provider', 'service_provider']),
        interaction('service_provider', 'provider', ['provider', 'service_provider']),
      ],
    },
  },
});

// Mirrors purple_dot/alimco, with provider→provider left NOT exportable.
const purpleDotLike = parseNetworkConfigDocument({
  id: 'purple_dot',
  domains: [domain('seeker'), domain('provider')],
  actions: {
    connect: {
      interactions: [
        interaction('seeker', 'provider', ['provider']),
        interaction('provider', 'seeker', ['provider']),
        interaction('provider', 'provider'),
      ],
    },
  },
});

describe('getInteractionExportRequesterDomains', () => {
  const lookup = (cfg: typeof blueDotLike, actionType: string, from: string, to: string) =>
    getInteractionExportRequesterDomains(cfg, {
      actionType,
      fromNetwork: cfg.id,
      fromDomain: from,
      toNetwork: cfg.id,
      toDomain: to,
    });

  it('returns the declared requester domains for each direction', () => {
    expect(lookup(purpleDotLike, 'connect', 'seeker', 'provider')).toEqual(['provider']);
    expect(lookup(purpleDotLike, 'connect', 'provider', 'seeker')).toEqual(['provider']);
  });

  it('returns [] when the interaction declares no export block', () => {
    expect(lookup(purpleDotLike, 'connect', 'provider', 'provider')).toEqual([]);
  });

  it('throws for an interaction the network does not declare', () => {
    expect(() => lookup(purpleDotLike, 'connect', 'seeker', 'seeker')).toThrow();
  });
});

describe('getExportableCounterparties', () => {
  it('blue_dot service_provider → seeker and provider', () => {
    expect(getExportableCounterparties(blueDotLike, 'service_provider')).toEqual([
      { network: 'blue_dot', domain: 'provider' },
      { network: 'blue_dot', domain: 'seeker' },
    ]);
  });

  it('blue_dot provider → seeker and service_provider (across apply + connect)', () => {
    expect(getExportableCounterparties(blueDotLike, 'provider')).toEqual([
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'blue_dot', domain: 'service_provider' },
    ]);
  });

  it('purple_dot provider → seeker only (provider→provider not exportable)', () => {
    expect(getExportableCounterparties(purpleDotLike, 'provider')).toEqual([
      { network: 'purple_dot', domain: 'seeker' },
    ]);
  });

  it('seeker → nothing in v1', () => {
    expect(getExportableCounterparties(purpleDotLike, 'seeker')).toEqual([]);
    expect(getExportableCounterparties(blueDotLike, 'seeker')).toEqual([]);
  });

  it('a network with no export blocks → nothing', () => {
    const cfg = parseNetworkConfigDocument({
      id: 'plain',
      domains: [domain('a'), domain('b')],
      actions: { connect: { interactions: [interaction('a', 'b')] } },
    });
    expect(getExportableCounterparties(cfg, 'a')).toEqual([]);
  });

  it('same-domain interaction yields that domain as counterparty', () => {
    const cfg = parseNetworkConfigDocument({
      id: 'n',
      domains: [domain('provider')],
      actions: {
        connect: { interactions: [interaction('provider', 'provider', ['provider'])] },
      },
    });
    expect(getExportableCounterparties(cfg, 'provider')).toEqual([
      { network: 'n', domain: 'provider' },
    ]);
  });

  it('resolves the counterparty network for a cross-network interaction', () => {
    const cfg = parseNetworkConfigDocument({
      id: 'home',
      domains: [domain('provider')],
      actions: {
        connect: {
          interactions: [
            {
              ...interaction('seeker', 'provider', ['provider']),
              from_network: 'other',
            },
          ],
        },
      },
    });
    expect(getExportableCounterparties(cfg, 'provider')).toEqual([
      { network: 'other', domain: 'seeker' },
    ]);
  });
});
