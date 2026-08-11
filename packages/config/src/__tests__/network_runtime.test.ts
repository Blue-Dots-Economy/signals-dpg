import { describe, it, expect } from 'vitest';
import {
  getAllowedInstanceOriginsFromNetworkConfig,
  parseNetworkConfigUrls,
  parseSchemaRegistryUrls,
  parseServedDomains,
  type NetworkConfig,
} from '../network_runtime';

describe('parseServedDomains', () => {
  it('parses a comma-separated list into network/domain bindings', () => {
    expect(parseServedDomains('yellow_dot/student,yellow_dot/tutor')).toEqual([
      { network: 'yellow_dot', domain: 'student', key: 'yellow_dot/student' },
      { network: 'yellow_dot', domain: 'tutor', key: 'yellow_dot/tutor' },
    ]);
  });

  it('tolerates surrounding whitespace and empty entries', () => {
    expect(parseServedDomains('  blue_dot/employer , ,')).toEqual([
      { network: 'blue_dot', domain: 'employer', key: 'blue_dot/employer' },
    ]);
  });

  it('drops duplicate bindings, keeping the first occurrence', () => {
    expect(
      parseServedDomains('blue_dot/employer,blue_dot/employer,blue_dot/seeker')
    ).toEqual([
      { network: 'blue_dot', domain: 'employer', key: 'blue_dot/employer' },
      { network: 'blue_dot', domain: 'seeker', key: 'blue_dot/seeker' },
    ]);
  });

  it('returns an empty list for an empty input', () => {
    expect(parseServedDomains('')).toEqual([]);
    expect(parseServedDomains('   ,  ')).toEqual([]);
  });

  it('rejects an entry that is not "network/domain"', () => {
    expect(() => parseServedDomains('yellow_dot')).toThrow(
      /Invalid SERVED_DOMAINS entry "yellow_dot"/
    );
    expect(() => parseServedDomains('yellow_dot/')).toThrow(/Invalid SERVED_DOMAINS/);
    expect(() => parseServedDomains('yellow_dot/student/extra')).toThrow(
      /Invalid SERVED_DOMAINS/
    );
  });

  it('rejects uppercase, leading-digit and hyphenated identifiers', () => {
    expect(() => parseServedDomains('Yellow_dot/student')).toThrow(/Invalid SERVED_DOMAINS/);
    expect(() => parseServedDomains('1yellow/student')).toThrow(/Invalid SERVED_DOMAINS/);
    expect(() => parseServedDomains('yellow-dot/student')).toThrow(/Invalid SERVED_DOMAINS/);
  });
});

describe('getAllowedInstanceOriginsFromNetworkConfig', () => {
  const served = [{ network: 'yellow_dot', domain: 'student', key: 'yellow_dot/student' }];

  it('returns [] when the network config declares no instances', () => {
    expect(
      getAllowedInstanceOriginsFromNetworkConfig({ id: 'yellow_dot' }, served)
    ).toEqual([]);
    expect(
      getAllowedInstanceOriginsFromNetworkConfig({ id: 'yellow_dot', instances: [] }, served)
    ).toEqual([]);
  });

  it('returns [] when no served binding belongs to this network', () => {
    const config: NetworkConfig = {
      id: 'blue_dot',
      instances: [{ domain_id: 'student', instance_url: 'https://blue.example.test/api' }],
    };

    expect(getAllowedInstanceOriginsFromNetworkConfig(config, served)).toEqual([]);
  });

  it('maps instance URLs of served domains down to bare origins', () => {
    const config: NetworkConfig = {
      id: 'yellow_dot',
      instances: [
        { domain_id: 'student', instance_url: 'https://a.example.test/api/v1' },
        { domain_id: 'tutor', instance_url: 'https://b.example.test/api/v1' },
      ],
    };

    expect(getAllowedInstanceOriginsFromNetworkConfig(config, served)).toEqual([
      'https://a.example.test',
    ]);
  });

  it('de-duplicates origins shared by several instances', () => {
    const config: NetworkConfig = {
      id: 'yellow_dot',
      instances: [
        { domain_id: 'student', instance_url: 'https://a.example.test/one' },
        { domain_id: 'student', instance_url: 'https://a.example.test/two' },
      ],
    };

    expect(getAllowedInstanceOriginsFromNetworkConfig(config, served)).toEqual([
      'https://a.example.test',
    ]);
  });

  it('also allows the from_domain of an interaction that targets a served domain', () => {
    const config: NetworkConfig = {
      id: 'yellow_dot',
      instances: [
        { domain_id: 'student', instance_url: 'https://a.example.test' },
        { domain_id: 'tutor', instance_url: 'https://tutor.example.test' },
      ],
      actions: {
        connect: {
          interactions: [
            { from_domain: 'tutor', to_domain: 'student', requirement_schema: {} },
          ],
        },
      },
    };

    expect(getAllowedInstanceOriginsFromNetworkConfig(config, served)).toEqual([
      'https://a.example.test',
      'https://tutor.example.test',
    ]);
  });

  it('does not allow a from_domain whose interaction targets an unserved domain', () => {
    const config: NetworkConfig = {
      id: 'yellow_dot',
      instances: [
        { domain_id: 'student', instance_url: 'https://a.example.test' },
        { domain_id: 'counsellor', instance_url: 'https://counsellor.example.test' },
      ],
      actions: {
        connect: {
          interactions: [
            { from_domain: 'counsellor', to_domain: 'tutor', requirement_schema: {} },
          ],
        },
        // An action with no interactions must not break the traversal.
        idle: {},
      },
    };

    expect(getAllowedInstanceOriginsFromNetworkConfig(config, served)).toEqual([
      'https://a.example.test',
    ]);
  });
});

describe('parseNetworkConfigUrls', () => {
  it('keeps a URL that already points at a .json document', () => {
    expect(
      parseNetworkConfigUrls('yellow_dot=https://reg.example.test/yellow_dot/network.json')
    ).toEqual({
      yellow_dot: 'https://reg.example.test/yellow_dot/network.json',
    });
  });

  it('appends network.json to a base URL that is not a .json document', () => {
    expect(parseNetworkConfigUrls('yellow_dot=https://reg.example.test/yellow_dot')).toEqual({
      yellow_dot: 'https://reg.example.test/yellow_dot/network.json',
    });
  });

  it('handles a base URL that already ends in a slash', () => {
    expect(parseNetworkConfigUrls('blue_dot=https://reg.example.test/blue_dot/')).toEqual({
      blue_dot: 'https://reg.example.test/blue_dot/network.json',
    });
  });

  it('parses several entries and trims whitespace', () => {
    expect(
      parseNetworkConfigUrls(
        ' yellow_dot = https://a.example.test/n.json , blue_dot=https://b.example.test/n.json ,'
      )
    ).toEqual({
      yellow_dot: 'https://a.example.test/n.json',
      blue_dot: 'https://b.example.test/n.json',
    });
  });

  it('returns {} for an empty input', () => {
    expect(parseNetworkConfigUrls('')).toEqual({});
  });

  it('rejects an entry without a network=url pair', () => {
    expect(() => parseNetworkConfigUrls('https://a.example.test/n.json')).toThrow(
      /Invalid NETWORK_CONFIG_URLS entry/
    );
    expect(() => parseNetworkConfigUrls('=https://a.example.test/n.json')).toThrow(
      /Invalid NETWORK_CONFIG_URLS entry/
    );
    expect(() => parseNetworkConfigUrls('yellow_dot=')).toThrow(
      /Invalid NETWORK_CONFIG_URLS entry/
    );
  });
});

describe('parseSchemaRegistryUrls', () => {
  it('returns {} when the input is empty', () => {
    expect(parseSchemaRegistryUrls('', ['yellow_dot'])).toEqual({});
    expect(parseSchemaRegistryUrls('  , ', ['yellow_dot'])).toEqual({});
  });

  it('derives <base>/<network>/network.json from a single base URL', () => {
    expect(
      parseSchemaRegistryUrls('https://reg.example.test/schemas', [
        'yellow_dot',
        'blue_dot',
      ])
    ).toEqual({
      yellow_dot: 'https://reg.example.test/schemas/yellow_dot/network.json',
      blue_dot: 'https://reg.example.test/schemas/blue_dot/network.json',
    });
  });

  it('de-duplicates repeated served networks', () => {
    expect(
      parseSchemaRegistryUrls('https://reg.example.test/schemas/', [
        'yellow_dot',
        'yellow_dot',
      ])
    ).toEqual({
      yellow_dot: 'https://reg.example.test/schemas/yellow_dot/network.json',
    });
  });

  it('throws when a bare base URL is given with no served networks', () => {
    expect(() => parseSchemaRegistryUrls('https://reg.example.test/schemas', [])).toThrow(
      /without any served networks/
    );
  });

  it('throws when several bare base URLs are given', () => {
    expect(() =>
      parseSchemaRegistryUrls('https://a.example.test,https://b.example.test', ['yellow_dot'])
    ).toThrow(/single base URL or comma-separated "network=url" mappings/);
  });

  it('uses explicit network=url mappings when any entry contains "="', () => {
    expect(
      parseSchemaRegistryUrls(
        'yellow_dot=https://a.example.test/network.json,blue_dot=https://b.example.test/blue',
        ['yellow_dot']
      )
    ).toEqual({
      yellow_dot: 'https://a.example.test/network.json',
      blue_dot: 'https://b.example.test/blue/network.json',
    });
  });

  it('rejects a bare entry mixed in with explicit mappings', () => {
    expect(() =>
      parseSchemaRegistryUrls(
        'yellow_dot=https://a.example.test/network.json,https://b.example.test',
        ['yellow_dot']
      )
    ).toThrow(/Invalid SCHEMA_REGISTRY_URL entry/);
  });

  it('rejects an explicit mapping with a blank side', () => {
    expect(() =>
      parseSchemaRegistryUrls('yellow_dot=,blue_dot=https://b.example.test/n.json', [])
    ).toThrow(/Invalid SCHEMA_REGISTRY_URL entry/);
  });
});
