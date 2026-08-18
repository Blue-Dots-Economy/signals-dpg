import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// --- mocks (hoisted) -------------------------------------------------------
const { scanStream, unlink, del } = vi.hoisted(() => ({
  scanStream: vi.fn(),
  unlink: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@api/db/secondary/redis', () => ({
  redis: { scanStream, unlink, del },
}));

import { invalidateItemFetchCache } from '../item_fetch_cache_invalidate';

/**
 * Builds a fake ioredis scan stream that emits `batches` then ends. The real
 * scanStream emits arrays of keys; emission is deferred to a microtask so the
 * production code has a chance to attach its listeners first.
 */
function fakeStream(batches: string[][]) {
  const stream = new EventEmitter();
  queueMicrotask(() => {
    for (const batch of batches) stream.emit('data', batch);
    stream.emit('end');
  });
  return stream;
}

describe('invalidateItemFetchCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlink.mockResolvedValue(1);
    del.mockResolvedValue(1);
  });

  it('sweeps all three cache families for the given network/domain', async () => {
    scanStream.mockImplementation(() => fakeStream([]));

    await invalidateItemFetchCache('blue_dot', 'seeker');

    const patterns = scanStream.mock.calls.map(
      (c) => (c[0] as { match: string }).match,
    );
    expect(patterns).toEqual([
      'local-item-fetch:*blue_dot*seeker*',
      'item-count:blue_dot:seeker:*',
      'item-page:blue_dot:seeker:*',
    ]);
  });

  it('uses SCAN (not KEYS) so Redis stays responsive on large keyspaces', async () => {
    scanStream.mockImplementation(() => fakeStream([]));

    await invalidateItemFetchCache('blue_dot', 'seeker');

    expect(scanStream).toHaveBeenCalledTimes(3);
    for (const call of scanStream.mock.calls) {
      expect((call[0] as { count: number }).count).toBe(200);
    }
  });

  it('unlinks every matched key', async () => {
    scanStream.mockImplementation(() => fakeStream([['k1', 'k2']]));

    await invalidateItemFetchCache('blue_dot', 'seeker');

    expect(unlink).toHaveBeenCalledTimes(3);
    expect(unlink).toHaveBeenCalledWith('k1', 'k2');
    expect(del).not.toHaveBeenCalled();
  });

  it('handles multiple data batches from one stream', async () => {
    scanStream.mockImplementation(() => fakeStream([['a'], ['b', 'c']]));

    await invalidateItemFetchCache('blue_dot', 'seeker');

    // 2 batches x 3 patterns.
    expect(unlink).toHaveBeenCalledTimes(6);
  });

  it('skips empty key batches rather than issuing a no-arg unlink', async () => {
    scanStream.mockImplementation(() => fakeStream([[], ['only']]));

    await invalidateItemFetchCache('blue_dot', 'seeker');

    expect(unlink).toHaveBeenCalledTimes(3);
    expect(unlink).toHaveBeenCalledWith('only');
  });

  it('falls back to DEL when UNLINK is unavailable on an older Redis', async () => {
    scanStream.mockImplementation(() => fakeStream([['k1']]));
    unlink.mockRejectedValue(new Error('ERR unknown command UNLINK'));

    await invalidateItemFetchCache('blue_dot', 'seeker');

    expect(del).toHaveBeenCalledTimes(3);
    expect(del).toHaveBeenCalledWith('k1');
  });

  it('rejects when the scan stream errors', async () => {
    scanStream.mockImplementation(() => {
      const stream = new EventEmitter();
      queueMicrotask(() => stream.emit('error', new Error('redis down')));
      return stream;
    });

    await expect(
      invalidateItemFetchCache('blue_dot', 'seeker'),
    ).rejects.toThrow('redis down');
  });

  it('resolves without deleting anything when nothing matches', async () => {
    scanStream.mockImplementation(() => fakeStream([]));

    await expect(
      invalidateItemFetchCache('blue_dot', 'seeker'),
    ).resolves.toBeUndefined();
    expect(unlink).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
