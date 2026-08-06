import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const { getNetworkConfigs } = vi.hoisted(() => ({
  getNetworkConfigs: vi.fn(),
}));

vi.mock('@/config', () => ({
  apiConfig: {
    served_domains: [
      { key: 'blue_dot/seeker', network: 'blue_dot', domain: 'seeker' },
      { key: 'blue_dot/provider', network: 'blue_dot', domain: 'provider' },
      { key: 'yellow_dot/student', network: 'yellow_dot', domain: 'student' },
    ],
  },
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigs: () => getNetworkConfigs(),
}));

import {
  isServedDomainBinding,
  getServedDomainSummary,
  replyForUnservedDomain,
} from '../served_domain_guard';

interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

describe('isServedDomainBinding', () => {
  it('matches a configured network/domain pair', () => {
    expect(isServedDomainBinding('blue_dot', 'seeker')).toBe(true);
    expect(isServedDomainBinding('yellow_dot', 'student')).toBe(true);
  });

  it('requires BOTH network and domain to match the same binding', () => {
    // Each half exists in the config, but not paired together.
    expect(isServedDomainBinding('yellow_dot', 'seeker')).toBe(false);
    expect(isServedDomainBinding('blue_dot', 'student')).toBe(false);
  });

  it('rejects an entirely unknown network or domain', () => {
    expect(isServedDomainBinding('green_dot', 'seeker')).toBe(false);
    expect(isServedDomainBinding('blue_dot', 'ghost')).toBe(false);
  });
});

describe('getServedDomainSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('de-duplicates networks and domains across bindings', async () => {
    getNetworkConfigs.mockResolvedValue([]);

    const summary = await getServedDomainSummary();

    // blue_dot appears in two bindings but must be listed once.
    expect(summary.networks).toEqual(['blue_dot', 'yellow_dot']);
    expect(summary.domains).toEqual(['seeker', 'provider', 'student']);
    expect(summary.bindings).toEqual([
      'blue_dot/seeker',
      'blue_dot/provider',
      'yellow_dot/student',
    ]);
  });

  it('maps each binding to the item_schemas keys of its domain config', async () => {
    getNetworkConfigs.mockResolvedValue([
      {
        id: 'blue_dot',
        domains: [
          {
            id: 'seeker',
            item_schemas: { 'profile_1.0': {}, 'post_1.0': {} },
          },
          { id: 'provider', item_schemas: { 'profile_1.0': {} } },
        ],
      },
      {
        id: 'yellow_dot',
        domains: [{ id: 'student', item_schemas: { 'application_1.0': {} } }],
      },
    ]);

    const summary = await getServedDomainSummary();

    expect(summary.item_types_by_binding).toEqual({
      'blue_dot/seeker': ['profile_1.0', 'post_1.0'],
      'blue_dot/provider': ['profile_1.0'],
      'yellow_dot/student': ['application_1.0'],
    });
  });

  it('yields an empty item-type list when the network config is missing', async () => {
    getNetworkConfigs.mockResolvedValue([]);

    const summary = await getServedDomainSummary();

    expect(summary.item_types_by_binding).toEqual({
      'blue_dot/seeker': [],
      'blue_dot/provider': [],
      'yellow_dot/student': [],
    });
  });

  it('yields an empty item-type list when the domain is absent from a found network', async () => {
    getNetworkConfigs.mockResolvedValue([
      { id: 'blue_dot', domains: [{ id: 'someone_else', item_schemas: {} }] },
    ]);

    const summary = await getServedDomainSummary();

    expect(summary.item_types_by_binding['blue_dot/seeker']).toEqual([]);
  });

  it('tolerates a domain config with no item_schemas key at all', async () => {
    getNetworkConfigs.mockResolvedValue([
      { id: 'blue_dot', domains: [{ id: 'seeker' }] },
    ]);

    const summary = await getServedDomainSummary();

    expect(summary.item_types_by_binding['blue_dot/seeker']).toEqual([]);
  });
});

describe('replyForUnservedDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 UNSERVED_DOMAIN_BINDING echoing the requested binding', async () => {
    getNetworkConfigs.mockResolvedValue([]);
    const reply = makeReply();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await replyForUnservedDomain(reply as any, 'green_dot', 'ghost');

    expect(reply.statusCode).toBe(403);
    const body = reply.body as {
      error: string;
      message: string;
      requested: { network: string; domain: string; key: string };
    };
    expect(body.error).toBe('UNSERVED_DOMAIN_BINDING');
    expect(body.message).toContain('green_dot/ghost');
    expect(body.requested).toEqual({
      network: 'green_dot',
      domain: 'ghost',
      key: 'green_dot/ghost',
    });
  });

  it('includes the allowed bindings/networks/domains so callers can self-correct', async () => {
    getNetworkConfigs.mockResolvedValue([]);
    const reply = makeReply();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await replyForUnservedDomain(reply as any, 'green_dot', 'ghost');

    const body = reply.body as {
      allowed_bindings: string[];
      allowed_networks: string[];
      allowed_domains: string[];
      allowed_item_types_by_binding: Record<string, string[]>;
    };
    expect(body.allowed_bindings).toEqual([
      'blue_dot/seeker',
      'blue_dot/provider',
      'yellow_dot/student',
    ]);
    expect(body.allowed_networks).toEqual(['blue_dot', 'yellow_dot']);
    expect(body.allowed_domains).toEqual(['seeker', 'provider', 'student']);
    expect(body.allowed_item_types_by_binding).toBeDefined();
  });
});
