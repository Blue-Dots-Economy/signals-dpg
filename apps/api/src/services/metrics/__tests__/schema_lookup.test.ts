import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const { getNetworkConfigById, getDomainItemSchema } = vi.hoisted(() => ({
  getNetworkConfigById: vi.fn(),
  getDomainItemSchema: vi.fn(),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: unknown[]) => getNetworkConfigById(...a),
}));

vi.mock('@dpg/schemas', () => ({
  getDomainItemSchema: (...a: unknown[]) => getDomainItemSchema(...a),
}));

import { get_item_schema } from '../schema_lookup';

describe('get_item_schema', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the schema for a (network, domain, item_type) triple', async () => {
    const schema = {
      type: 'object',
      required: ['fullName'],
      properties: { fullName: {} },
    };
    getNetworkConfigById.mockResolvedValue({ id: 'blue_dot' });
    getDomainItemSchema.mockReturnValue(schema);

    await expect(
      get_item_schema('blue_dot', 'seeker', 'profile_1.0'),
    ).resolves.toEqual(schema);
  });

  it('looks the network up first, then the domain item schema within it', async () => {
    getNetworkConfigById.mockResolvedValue({ id: 'blue_dot' });
    getDomainItemSchema.mockReturnValue({});

    await get_item_schema('blue_dot', 'seeker', 'profile_1.0');

    expect(getNetworkConfigById).toHaveBeenCalledWith('blue_dot');
    expect(getDomainItemSchema).toHaveBeenCalledWith(
      { id: 'blue_dot' },
      'seeker',
      'profile_1.0',
    );
  });

  it('propagates when the triple has no schema configured', async () => {
    getNetworkConfigById.mockResolvedValue({ id: 'blue_dot' });
    getDomainItemSchema.mockImplementation(() => {
      throw new Error('no schema for blue_dot/seeker/ghost_1.0');
    });

    await expect(
      get_item_schema('blue_dot', 'seeker', 'ghost_1.0'),
    ).rejects.toThrow('no schema for blue_dot/seeker/ghost_1.0');
  });

  it('propagates an unknown-network failure', async () => {
    getNetworkConfigById.mockRejectedValue(new Error('unknown network'));

    await expect(
      get_item_schema('green_dot', 'seeker', 'profile_1.0'),
    ).rejects.toThrow('unknown network');
    expect(getDomainItemSchema).not.toHaveBeenCalled();
  });
});
