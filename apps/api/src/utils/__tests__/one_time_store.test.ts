import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

const redisSet = vi.fn();
const redisGet = vi.fn();
const redisGetdel = vi.fn();
vi.mock('@api/db/secondary/redis', () => ({
  redis: { set: redisSet, get: redisGet, getdel: redisGetdel },
}));

const { claimOnce, peekValue, putValue, takeValue } = await import('../one_time_store.js');

const hashed = (id: string) => 'p:' + createHash('sha256').update(id).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('one_time_store', () => {
  it('never uses the raw id as the key', async () => {
    await putValue('p:', 'secret-id', { a: 1 }, 60);
    expect(redisSet).toHaveBeenCalledWith(hashed('secret-id'), '{"a":1}', 'EX', 60);
  });

  it('peek reads without deleting', async () => {
    redisGet.mockResolvedValue('{"a":1}');
    expect(await peekValue('p:', 'id')).toEqual({ a: 1 });
    expect(redisGet).toHaveBeenCalledWith(hashed('id'));
    expect(redisGetdel).not.toHaveBeenCalled();
  });

  it('take reads and deletes in one step', async () => {
    redisGetdel.mockResolvedValue('{"a":1}');
    expect(await takeValue('p:', 'id')).toEqual({ a: 1 });
    expect(redisGetdel).toHaveBeenCalledWith(hashed('id'));
  });

  it('returns null for a missing or corrupt value', async () => {
    redisGetdel.mockResolvedValueOnce(null).mockResolvedValueOnce('{nope');
    expect(await takeValue('p:', 'id')).toBeNull();
    expect(await takeValue('p:', 'id')).toBeNull();
  });

  it('claimOnce is true the first time and false on a repeat', async () => {
    redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    expect(await claimOnce('p:', 'id', 300)).toBe(true);
    expect(await claimOnce('p:', 'id', 300)).toBe(false);
    expect(redisSet).toHaveBeenCalledWith(hashed('id'), '1', 'EX', 300, 'NX');
  });
});
