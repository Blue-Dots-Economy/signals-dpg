import { describe, it, expect } from 'vitest';
import { FetchOwnedActionsQuerySchema } from '../action_schemas';

describe('FetchOwnedActionsQuerySchema', () => {
  it('coerces a single action_status to an array', () => {
    const q = FetchOwnedActionsQuerySchema.parse({ action_status: 'created' });
    expect(q.action_status).toEqual(['created']);
  });
  it('accepts repeated action_status values', () => {
    const q = FetchOwnedActionsQuerySchema.parse({ action_status: ['created', 'pending'] });
    expect(q.action_status).toEqual(['created', 'pending']);
  });
  it('defaults sort to recent and rejects unknown sort keys', () => {
    expect(FetchOwnedActionsQuerySchema.parse({}).sort).toBe('recent');
    expect(() => FetchOwnedActionsQuerySchema.parse({ sort: 'name' })).toThrow();
  });
});
