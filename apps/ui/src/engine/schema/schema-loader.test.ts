import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCachedSchema, setCachedSchema, clearSchemaCache } from './schema-loader';
import type { RJSFSchema } from '@rjsf/utils';

const schema: RJSFSchema = { type: 'object', properties: { a: { type: 'string' } } };

describe('schema cache TTL', () => {
  beforeEach(() => {
    clearSchemaCache();
    vi.useRealTimers();
  });

  it('returns a cached schema before the TTL elapses', () => {
    vi.useFakeTimers();
    setCachedSchema('k', schema);
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 min < 5 min TTL
    expect(getCachedSchema('k')).toEqual(schema);
  });

  it('treats an entry past the TTL as a miss', () => {
    vi.useFakeTimers();
    setCachedSchema('k', schema);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1); // just past TTL
    expect(getCachedSchema('k')).toBeUndefined();
  });

  it('clearSchemaCache drops entries', () => {
    setCachedSchema('k', schema);
    clearSchemaCache();
    expect(getCachedSchema('k')).toBeUndefined();
  });
});
