import { describe, it, expect } from 'vitest';
import type { DotNetworkSchema } from '@/engine/types';
import { computeVisibleDomains } from './visible-domains';

function makeNetwork(): DotNetworkSchema {
  return {
    id: 'purple_dot',
    domains: [
      { id: 'seeker', description: 'Seeker' },
      { id: 'provider', description: 'Provider' },
    ],
    actions: {
      connect: {
        description: 'connect',
        interactions: [
          { from_domain: 'seeker', to_domain: 'provider', requirement_schema: {} },
          { from_domain: 'provider', to_domain: 'seeker', requirement_schema: {} },
          { from_domain: 'provider', to_domain: 'provider', requirement_schema: {} },
        ],
      },
    },
  } as unknown as DotNetworkSchema;
}

const ids = (n: DotNetworkSchema, v: string | null) =>
  computeVisibleDomains(n, v).map((d) => d.id);

describe('computeVisibleDomains', () => {
  it('seeker sees only providers', () => {
    expect(ids(makeNetwork(), 'seeker')).toEqual(['provider']);
  });
  it('provider sees seeker and provider', () => {
    expect(ids(makeNetwork(), 'provider')).toEqual(['seeker', 'provider']);
  });
  it('null viewer sees all browseable domains', () => {
    expect(ids(makeNetwork(), null)).toEqual(['seeker', 'provider']);
  });
  it('a domain with no outgoing edge sees nothing', () => {
    const n = makeNetwork();
    n.actions.connect.interactions = n.actions.connect.interactions.filter(
      (i) => i.from_domain !== 'provider',
    );
    expect(ids(n, 'provider')).toEqual([]);
  });
  it('ignores cross-network from_network edges', () => {
    const n = makeNetwork();
    n.actions.connect.interactions.push({
      from_network: 'yellow_dot',
      from_domain: 'seeker',
      to_domain: 'seeker',
      requirement_schema: {},
    } as DotNetworkSchema['actions'][string]['interactions'][number]);
    expect(ids(n, 'seeker')).toEqual(['provider']);
  });

  // Directory networks (e.g. orange_dot) have a domain but no action/interaction
  // edges. Without a fallback, computeVisibleDomains returns [] and the portal
  // never fetches items. A network with no edges is a directory: browse it all.
  function makeDirectoryNetwork(): DotNetworkSchema {
    return {
      id: 'orange_dot',
      domains: [{ id: 'practitioner', description: 'Practitioner' }],
      actions: {},
    } as unknown as DotNetworkSchema;
  }

  it('directory network (no interactions) shows all domains to a null viewer', () => {
    expect(ids(makeDirectoryNetwork(), null)).toEqual(['practitioner']);
  });

  it('directory network (no interactions) shows all domains to a domain viewer', () => {
    expect(ids(makeDirectoryNetwork(), 'practitioner')).toEqual(['practitioner']);
  });

  it('treats a network whose actions all have empty interactions as a directory', () => {
    const n = makeDirectoryNetwork();
    (n as unknown as { actions: Record<string, { interactions: unknown[] }> }).actions = {
      view: { interactions: [] },
    };
    expect(ids(n, null)).toEqual(['practitioner']);
  });

  it('tolerates a missing actions map (directory)', () => {
    const n = makeDirectoryNetwork();
    delete (n as unknown as { actions?: unknown }).actions;
    expect(ids(n, null)).toEqual(['practitioner']);
  });
});
