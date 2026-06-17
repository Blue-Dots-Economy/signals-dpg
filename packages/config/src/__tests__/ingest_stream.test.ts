import { describe, it, expect } from 'vitest';
import { DatabaseSecretsSchema } from '../secrets.js';

const base = {
  POSTGRES_USER: 'dpg',
  POSTGRES_PASSWORD: 'password12',
  POSTGRES_DB: 'dpg',
  REDIS_PASSWORD: 'redispw',
};

describe('DatabaseSecretsSchema INGEST_STREAM', () => {
  it('defaults to signals:item-events', () => {
    const parsed = DatabaseSecretsSchema.parse(base);
    expect(parsed.INGEST_STREAM).toBe('signals:item-events');
  });

  it('accepts an override', () => {
    const parsed = DatabaseSecretsSchema.parse({ ...base, INGEST_STREAM: 'custom:stream' });
    expect(parsed.INGEST_STREAM).toBe('custom:stream');
  });
});
