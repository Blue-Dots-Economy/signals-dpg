import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const { createItemInternal, resolveLocationsForCreate } = vi.hoisted(() => ({
  createItemInternal: vi.fn(),
  resolveLocationsForCreate: vi.fn(),
}));

vi.mock('@/services/item_service', () => ({
  createItemInternal: (...a: unknown[]) => createItemInternal(...a),
}));

vi.mock('@/services/geocoding/resolve_locations_for_create', () => ({
  resolveLocationsForCreate: (...a: unknown[]) =>
    resolveLocationsForCreate(...a),
}));

import { create_profile_item } from '../profile_item';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tx = { marker: 'the-caller-transaction' } as any;

const input = {
  tx,
  user_id: 'u1',
  network: 'blue_dot',
  domain: 'seeker',
  item_type: 'profile_1.0',
  payload: { fullName: 'Ada', address: '1 Main St' },
};

describe('create_profile_item', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveLocationsForCreate.mockResolvedValue([{ lat: 1, lon: 2 }]);
    createItemInternal.mockResolvedValue({ itemId: 'item-1' });
  });

  it('returns the created item id', async () => {
    await expect(create_profile_item(input)).resolves.toEqual({
      item_id: 'item-1',
    });
  });

  it("geocodes the profile payload so admin-onboarded items aren't stored without coordinates", async () => {
    await create_profile_item(input);

    expect(resolveLocationsForCreate).toHaveBeenCalledWith({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_state: input.payload,
    });
  });

  it('passes the resolved locations through to the item-create service', async () => {
    await create_profile_item(input);

    expect(createItemInternal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ item_locations: [{ lat: 1, lon: 2 }] }),
    );
  });

  it('creates the item inside the CALLER-supplied transaction (atomic with the user insert)', async () => {
    await create_profile_item(input);

    expect(createItemInternal.mock.calls[0][0]).toBe(tx);
  });

  it('makes the participant the author of their own row', async () => {
    await create_profile_item(input);

    expect(createItemInternal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ created_by: 'u1' }),
    );
  });

  it('forwards the network/domain/item_type and payload verbatim', async () => {
    await create_profile_item(input);

    expect(createItemInternal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: input.payload,
      }),
    );
  });

  it('propagates a geocoding failure rather than silently creating an unplaced item', async () => {
    resolveLocationsForCreate.mockRejectedValue(new Error('geocoder down'));

    await expect(create_profile_item(input)).rejects.toThrow('geocoder down');
    expect(createItemInternal).not.toHaveBeenCalled();
  });

  it('propagates a create failure from the item service', async () => {
    createItemInternal.mockRejectedValue(new Error('validation failed'));

    await expect(create_profile_item(input)).rejects.toThrow(
      'validation failed',
    );
  });
});
