import { describe, it, expect, vi, beforeEach } from 'vitest';

const { xadd } = vi.hoisted(() => ({ xadd: vi.fn() }));
vi.mock('@api/db/secondary/redis', () => ({ redis: { xadd } }));
vi.mock('@/config', () => ({
  databasesConfig: { ingest_stream: 'signals:item-events', ingest_stream_maxlen: 100_000 },
}));

import { publishItemEvent } from '../publish_item_event.js';

beforeEach(() => xadd.mockReset());

const evt = {
  item_network: 'purple_dot',
  item_domain: 'provider',
  item_type: 'profile_1.0',
  item_id: '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf',
  op: 'upsert' as const,
};

describe('publishItemEvent', () => {
  it('XADDs the event fields to the configured stream, approx-trimmed to MAXLEN', async () => {
    xadd.mockResolvedValueOnce('1-0');
    await publishItemEvent(evt);
    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0];
    expect(args[0]).toBe('signals:item-events');
    // Bounded stream: MAXLEN ~ <cap> must precede the `*` id.
    expect(args.slice(1, 5)).toEqual(['MAXLEN', '~', 100_000, '*']);
    expect(args).toContain('item_id');
    expect(args).toContain('5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf');
    expect(args).toContain('op');
    expect(args).toContain('upsert');
  });

  it('never throws when redis rejects (best-effort)', async () => {
    xadd.mockRejectedValueOnce(new Error('redis down'));
    const logger = { warn: vi.fn() };
    await expect(publishItemEvent(evt, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
