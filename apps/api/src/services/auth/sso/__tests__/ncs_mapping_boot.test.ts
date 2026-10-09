import { describe, it, expect, vi } from 'vitest';
import type { SsoNcsMapping } from '@dpg/config';
import type { NetworkConfigDocument } from '@dpg/schemas';

vi.mock('@api/db/secondary/redis', () => ({ redis: {} }));

const { assertNcsMappingMatchesNetwork } = await import('../ncs_mapping_boot.js');

const NETWORK = {
  id: 'blue_dot',
  domains: [
    {
      id: 'seeker',
      item_schemas: {
        'profile_1.0': {
          properties: {
            name: {},
            phone: {},
            location: {},
            age: { type: 'integer' },
            gender: { enum: ['Male', 'Female', 'Other'] },
          },
        },
      },
    },
  ],
} as unknown as NetworkConfigDocument;

const SERVED = [{ network: 'blue_dot', domain: 'seeker' }];

const mapping = (over: Partial<SsoNcsMapping> = {}): SsoNcsMapping => ({
  network: 'blue_dot',
  item_type: 'profile_1.0',
  role_to_domain: { JOBSEEKER: 'seeker' },
  fields: { fullName: 'name', mobileNumber: 'phone' },
  joined_fields: {},
  value_maps: {},
  age_from_dob: {},
  feature_routes: {},
  ...over,
});

describe('assertNcsMappingMatchesNetwork', () => {
  it('accepts a mapping whose targets are all in the schema', () => {
    expect(() => assertNcsMappingMatchesNetwork(mapping(), [NETWORK], SERVED)).not.toThrow();
  });

  it('rejects a target field the schema does not declare, naming it', () => {
    expect(() =>
      assertNcsMappingMatchesNetwork(
        mapping({ fields: { fullName: 'name', email: 'email' } }),
        [NETWORK],
        SERVED
      )
    ).toThrow(/field 'email' is not in blue_dot\/seeker\/profile_1.0/);
  });

  it('checks joined-field targets too', () => {
    expect(() =>
      assertNcsMappingMatchesNetwork(
        mapping({ joined_fields: { location: ['districtName', 'stateName'] } }),
        [NETWORK],
        SERVED
      )
    ).not.toThrow();
    expect(() =>
      assertNcsMappingMatchesNetwork(
        mapping({ joined_fields: { address: ['districtName', 'stateName'] } }),
        [NETWORK],
        SERVED
      )
    ).toThrow(/field 'address'/);
  });

  it('checks value_maps against the target enum, and age_from_dob targets', () => {
    const ok = mapping({
      fields: { fullName: 'name', gender: 'gender' },
      value_maps: { gender: { FEMALE: 'Female', MALE: 'Male' } },
      age_from_dob: { age: 'dateOfBirth' },
    });
    expect(() => assertNcsMappingMatchesNetwork(ok, [NETWORK], SERVED)).not.toThrow();
    expect(() =>
      assertNcsMappingMatchesNetwork(
        { ...ok, value_maps: { gender: { FEMALE: 'female' } } },
        [NETWORK],
        SERVED
      )
    ).toThrow(/maps to 'female', not an allowed value of 'gender'/);
    expect(() =>
      assertNcsMappingMatchesNetwork({ ...ok, value_maps: { sex: { F: 'Female' } } }, [NETWORK], SERVED)
    ).toThrow(/value_maps.sex has no matching entry in fields/);
    expect(() =>
      assertNcsMappingMatchesNetwork({ ...ok, age_from_dob: { years: 'dateOfBirth' } }, [NETWORK], SERVED)
    ).toThrow(/field 'years'/);
  });

  it('rejects a role mapped to a domain this instance does not serve', () => {
    expect(() =>
      assertNcsMappingMatchesNetwork(
        mapping({ role_to_domain: { EMPLOYER: 'provider' } }),
        [NETWORK],
        SERVED
      )
    ).toThrow(/domain 'provider' is not served/);
  });

  it('rejects an item type the domain does not have', () => {
    expect(() =>
      assertNcsMappingMatchesNetwork(mapping({ item_type: 'profile_2.0' }), [NETWORK], SERVED)
    ).toThrow(/no item type 'profile_2.0'/);
  });

  it('has nothing to check when no role is mapped', () => {
    expect(() =>
      assertNcsMappingMatchesNetwork(
        mapping({ role_to_domain: {}, fields: { x: 'nope' } }),
        [NETWORK],
        SERVED
      )
    ).not.toThrow();
  });
});
