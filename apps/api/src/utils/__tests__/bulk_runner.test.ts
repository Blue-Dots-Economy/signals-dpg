import { describe, it, expect, vi } from 'vitest';
import { runBulk, BulkItemFailure } from '../bulk_runner.js';

const opts = { okStatus: 201, maxItems: 3 };

describe('runBulk', () => {
  it('returns a request error for an empty array', async () => {
    const out = await runBulk([], async () => ({ ok: true }), opts);
    expect(out.requestError).toEqual({
      code: 'BULK_EMPTY_ARRAY',
      message: expect.any(String),
    });
    expect(out.results).toBeUndefined();
  });

  it('returns a request error when over the limit', async () => {
    const out = await runBulk([1, 2, 3, 4], async () => ({ ok: true }), opts);
    expect(out.requestError?.code).toBe('BULK_LIMIT_EXCEEDED');
    expect(out.requestError?.message).toEqual(expect.any(String));
    expect(out.results).toBeUndefined();
    expect(out.httpStatus).toBeUndefined();
  });

  it('returns okStatus when every item succeeds, preserving order + index', async () => {
    const out = await runBulk(
      ['a', 'b'],
      async (el, i) => ({ value: `${el as string}-${i}` }),
      opts,
    );
    expect(out.httpStatus).toBe(201);
    expect(out.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(out.results).toEqual([
      { index: 0, status: 'success', value: 'a-0' },
      { index: 1, status: 'success', value: 'b-1' },
    ]);
  });

  it('returns 207 on partial failure and maps BulkItemFailure', async () => {
    const spy = vi.fn();
    const out = await runBulk(
      ['ok', 'bad'],
      async (el) => {
        if (el === 'bad') throw new BulkItemFailure('NOPE', 'bad item');
        return { value: el };
      },
      { ...opts, onUnexpectedError: spy },
    );
    expect(out.httpStatus).toBe(207);
    expect(out.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(out.results?.[1]).toEqual({
      index: 1,
      status: 'error',
      error: 'NOPE',
      message: 'bad item',
    });
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('returns 422 when every item fails', async () => {
    const out = await runBulk(
      ['x'],
      async () => {
        throw new BulkItemFailure('NOPE', 'nope');
      },
      opts,
    );
    expect(out.httpStatus).toBe(422);
    expect(out.summary).toEqual({ total: 1, succeeded: 0, failed: 1 });
  });

  it('maps unknown throws to INTERNAL_SERVER_ERROR', async () => {
    const thrownError = new Error('boom');
    const spy = vi.fn();
    const out = await runBulk(
      ['x'],
      async () => {
        throw thrownError;
      },
      { ...opts, onUnexpectedError: spy },
    );
    expect(out.results?.[0]).toEqual({
      index: 0,
      status: 'error',
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(thrownError, 0);
  });
});
