import { describe, it, expect, vi, beforeEach } from 'vitest';

const { xadd } = vi.hoisted(() => ({ xadd: vi.fn() }));
vi.mock('@api/db/secondary/redis', () => ({ redis: { xadd } }));
vi.mock('@/config', () => ({
  databasesConfig: { ingest_stream: 'signals:item-events', ingest_stream_maxlen: 100_000 },
}));

import { publishItemEvent, publishItemEvents } from '../publish_item_event.js';

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

describe('publishItemEvents', () => {
  const key = (item_id: string, item_domain = 'provider') => ({
    item_network: 'purple_dot',
    item_domain,
    item_type: 'profile_1.0',
    item_id,
  });
  const publishedIds = () =>
    xadd.mock.calls.map((args) => args[args.indexOf('item_id') + 1]);

  it('publishes one event per key with the given op', async () => {
    xadd.mockResolvedValue('1-0');
    await publishItemEvents([key('itm-a'), key('itm-b')], 'upsert');
    expect(publishedIds()).toEqual(['itm-a', 'itm-b']);
    expect(xadd.mock.calls[0]).toContain('upsert');
  });

  it('de-duplicates repeated keys so one item is not indexed twice', async () => {
    // The participant branches pass their own item plus the drafts an age write
    // promoted; those two sets can overlap (#557). The worker is idempotent, but a
    // duplicate event still costs a needless read.
    xadd.mockResolvedValue('1-0');
    await publishItemEvents([key('itm-a'), key('itm-a'), key('itm-b')], 'upsert');
    expect(publishedIds()).toEqual(['itm-a', 'itm-b']);
  });

  it('treats keys differing only by domain as distinct', async () => {
    // De-duplication is on the FULL composite key, not item_id alone.
    xadd.mockResolvedValue('1-0');
    await publishItemEvents([key('itm-a', 'provider'), key('itm-a', 'seeker')], 'upsert');
    expect(xadd).toHaveBeenCalledTimes(2);
  });

  it('keeps publishing the rest when one item fails', async () => {
    // Best-effort per item, like publishItemEvent: one item's Redis failure must
    // not silently drop every item behind it.
    xadd.mockRejectedValueOnce(new Error('redis down')).mockResolvedValue('1-0');
    const logger = { warn: vi.fn() };
    await expect(
      publishItemEvents([key('itm-a'), key('itm-b')], 'upsert', logger),
    ).resolves.toBeUndefined();
    expect(publishedIds()).toEqual(['itm-a', 'itm-b']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('passes the delete op through', async () => {
    xadd.mockResolvedValue('1-0');
    await publishItemEvents([key('itm-a')], 'delete');
    expect(xadd.mock.calls[0]).toContain('delete');
  });

  it('is a no-op for an empty list', async () => {
    await publishItemEvents([], 'upsert');
    expect(xadd).not.toHaveBeenCalled();
  });
});
