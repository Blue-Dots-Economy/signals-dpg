import { describe, it, expect } from 'vitest';
import { isUniqueConstraintViolation, PG_UNIQUE_VIOLATION } from '@/utils/pg_errors';

describe('isUniqueConstraintViolation', () => {
  it('matches a top-level pg code — what the two auth writers relied on', () => {
    expect(isUniqueConstraintViolation({ code: PG_UNIQUE_VIOLATION })).toBe(true);
  });

  it('matches a code carried on `cause`, as Drizzle wraps it', () => {
    expect(isUniqueConstraintViolation({ cause: { code: PG_UNIQUE_VIOLATION } })).toBe(true);
  });

  // The message fallback is the superset the admin-onboarding path added; it
  // must survive consolidation or that race handling narrows.
  it('falls back to the message when the code is lost in wrapping', () => {
    expect(
      isUniqueConstraintViolation(
        new Error('duplicate key value violates unique constraint "user_email_unique"')
      )
    ).toBe(true);
    expect(isUniqueConstraintViolation(new Error('unique constraint failed'))).toBe(true);
  });

  it('does not match another pg error', () => {
    expect(isUniqueConstraintViolation({ code: '23503' })).toBe(false);
    expect(isUniqueConstraintViolation({ cause: { code: '23503' } })).toBe(false);
  });

  it('does not match an unrelated or absent error', () => {
    expect(isUniqueConstraintViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueConstraintViolation(null)).toBe(false);
    expect(isUniqueConstraintViolation(undefined)).toBe(false);
  });
});
