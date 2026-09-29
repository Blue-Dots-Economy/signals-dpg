import { describe, it, expect, vi, beforeEach } from 'vitest';

// A plain function in front of the spy: vi.fn records a rejected promise as
// a test failure even when the caller handles it.
const getNetworkConfigById = vi.fn();
let failWith: Error | null = null;
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: async (id: string) => {
    getNetworkConfigById(id);
    if (failWith) throw failWith;
    return { id };
  },
}));
const { memoizeNetworkConfigs } = await import('../network_config_memo');

beforeEach(() => {
  getNetworkConfigById.mockReset();
  failWith = null;
});

describe('memoizeNetworkConfigs', () => {
  it('loads each network once and reuses a seeded config', async () => {
    const load = memoizeNetworkConfigs(vi.fn(), { id: 'a', config: { id: 'a' } as never });
    expect(await load('a')).toEqual({ id: 'a' });
    await load('b');
    await load('b');
    expect(getNetworkConfigById).toHaveBeenCalledTimes(1);
  });

  it('reports a failed load once and remembers it as null', async () => {
    failWith = new Error('down');
    const onError = vi.fn();
    const load = memoizeNetworkConfigs(onError);
    expect(await load('x')).toBeNull();
    expect(await load('x')).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'x');
  });
});
