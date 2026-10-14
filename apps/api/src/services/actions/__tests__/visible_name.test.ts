import { describe, it, expect, vi } from 'vitest';
import { privateNameShown, visibleItemName } from '../visible_name';

const schema = { display_name_field: 'organisation_name', properties: { organisation_name: {} } };

describe('visibleItemName', () => {
  it('returns a public display name without decrypting', () => {
    const decrypt = vi.fn();
    expect(
      visibleItemName({ itemId: 'i', schema, publicState: { organisation_name: 'Kaveri Retail' }, revealed: false, decrypt })
    ).toBe('Kaveri Retail');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('never returns a private name that is not revealed — not even the mask', () => {
    const decrypt = vi.fn(() => ({ name: 'Aarti Sharma' }));
    expect(
      visibleItemName({ itemId: 'i', schema: {}, publicState: { name: 'A***' }, revealed: false, decrypt })
    ).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('returns the decrypted private name once revealed', () => {
    expect(
      visibleItemName({
        itemId: 'i',
        schema: {},
        publicState: { name: 'A***' },
        revealed: true,
        decrypt: () => ({ name: 'Aarti Sharma' }),
      })
    ).toBe('Aarti Sharma');
  });

  it('treats a failed decrypt as not visible', () => {
    expect(
      visibleItemName({
        itemId: 'i',
        schema: {},
        publicState: { name: 'A***' },
        revealed: true,
        decrypt: () => {
          throw new Error('bad key');
        },
      })
    ).toBeNull();
  });
});

describe('visibleItemName — decrypt failure', () => {
  it('reports the error and treats the name as masked', () => {
    const onDecryptError = vi.fn();
    const name = visibleItemName({
      itemId: 'i',
      schema: {},
      publicState: { name: 'A***' },
      revealed: true,
      decrypt: () => {
        throw new Error('bad blob');
      },
      onDecryptError,
    });
    expect(name).toBeNull();
    expect(onDecryptError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('privateNameShown', () => {
  it('needs both a revealing status and a live profile', () => {
    expect(privateNameShown(['accepted'], 'accepted', 'live')).toBe(true);
    expect(privateNameShown(['accepted'], 'created', 'live')).toBe(false);
    expect(privateNameShown(['accepted'], 'accepted', 'paused')).toBe(false);
    expect(privateNameShown([], 'accepted', 'live')).toBe(false);
  });
});
