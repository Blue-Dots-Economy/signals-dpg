import { describe, it, expect } from 'vitest';
import {
  BulkPerformActionResponseSchema,
  BulkUpdateActionStatusResponseSchema,
} from '../api/bulk_schemas';

describe('bulk response schemas', () => {
  it('accepts a mixed envelope (success + error)', () => {
    const parsed = BulkUpdateActionStatusResponseSchema.parse({
      results: [
        { index: 0, status: 'success', action_id: 'a', action_type: 'connect', action_status: 'accepted', update_count: 1 },
        { index: 1, status: 'error', error: 'INVALID_PAYLOAD', message: 'bad' },
      ],
      summary: { total: 2, succeeded: 1, failed: 1 },
    });
    expect(parsed.results).toHaveLength(2);
  });

  it('rejects a success entry missing a required field', () => {
    expect(() =>
      BulkUpdateActionStatusResponseSchema.parse({
        results: [{ index: 0, status: 'success', action_id: 'a' }],
        summary: { total: 1, succeeded: 1, failed: 0 },
      }),
    ).toThrow();
  });

  it('accepts perform + update envelopes', () => {
    expect(
      BulkPerformActionResponseSchema.parse({
        results: [
          {
            index: 0,
            status: 'success',
            action_id: 'a',
            action_type: 'connect',
            action_status: 'created',
            update_count: 0,
            source_item_id: 's',
            target_item_id: 't',
          },
        ],
        summary: { total: 1, succeeded: 1, failed: 0 },
      }).results,
    ).toHaveLength(1);

    expect(
      BulkUpdateActionStatusResponseSchema.parse({
        results: [
          {
            index: 0,
            status: 'success',
            action_id: 'a',
            action_type: 'connect',
            action_status: 'accepted',
            update_count: 1,
          },
        ],
        summary: { total: 1, succeeded: 1, failed: 0 },
      }).results,
    ).toHaveLength(1);
  });
});
