import { describe, it, expect } from 'vitest';
import {
  PENDING_ACTION_STATUSES,
  isPendingStatus,
} from '../cancel_pending_actions.js';

describe('PENDING_ACTION_STATUSES', () => {
  it('includes created + submitted', () => {
    expect(PENDING_ACTION_STATUSES).toContain('created');
    expect(PENDING_ACTION_STATUSES).toContain('submitted');
  });

  it('excludes terminal + accepted', () => {
    for (const terminal of [
      'accepted',
      'cancelled',
      'declined',
      'completed',
      'expired',
      'rejected',
    ]) {
      expect(PENDING_ACTION_STATUSES).not.toContain(terminal);
    }
  });

  it('isPendingStatus is a simple membership check', () => {
    expect(isPendingStatus('created')).toBe(true);
    expect(isPendingStatus('submitted')).toBe(true);
    expect(isPendingStatus('accepted')).toBe(false);
    expect(isPendingStatus('something_else')).toBe(false);
  });
});
